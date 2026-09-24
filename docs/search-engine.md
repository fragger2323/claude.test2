# Search engine

A search is a `SearchJob` executed by the worker as a checkpointed stage machine
(`src/engine/pipeline/search-pipeline.ts`):

```
planning → discovering → merging → verifying → website_discovery → analyzing → contacts → qualifying → reporting → completed
```

Each stage is idempotent and saves its progress. **Pause** takes effect at the next checkpoint (at
most one DB read per second). **Resume** and **retry** continue from the stored stage.
**Cancel** stops the job and keeps what was found. The job page shows the stage, the progress,
real counts computed from the job's own rows, the providers used with their status, the strategy
log and every query with its result count.

## 1. Planning: Search Strategy Engine

`src/engine/strategy/strategy-engine.ts`

- **Niche resolution.** The input is matched against `src/domain/taxonomy.ts` (about 34 niches,
  each with terms, specialties, OSM tags and categories in up to 12 languages). Matching is fuzzy
  and handles inflection, so *"стоматологии"*, *"dentysta"* and *"dental clinics"* all resolve
  to `dentist`. An unknown niche is used verbatim and the log says so.
- **Languages.** The country's languages come first (Poland → `pl`, then `en`), then the language
  you pick. At most three are used.
- **City.** Localised names (`Warszawa`/`Warsaw`/`Варшава`) and districts. For requests over
  40 leads, districts are fetched from OSM administrative boundaries; otherwise a built-in list
  is used where one exists (Warsaw, Kraków, Wrocław, Prague, Berlin).
- **Variations.** Primary term, synonyms, specialties (e.g. *implanty*, *ortodonta*), a
  secondary language and segment queries (*term + district + city*). Duplicates by text are
  removed and each query records its strategy and a stable `template` key.
- **Budget.** The number of queries depends on quantity: ≤20 → 6, ≤50 → 10, ≤100 → 16,
  ≤300 → 28, otherwise 40. Large requests always keep some segment queries.
- **Learning order.** Templates that produced high-priority leads and replies before get a
  priority boost. The smoothed yield is `(high + 3·replied + 1) / (unique + 5)`, applied once a
  template has at least 5 companies behind it. This is the search-quality loop, visible under
  **Learning → Query templates**.

Every planned query is saved as a `SearchQuery` row (text, language, segment, strategy,
template) and later updated with its result count, new-record count and errors.

## 2. Discovering: Source Orchestrator

`src/engine/orchestrator/source-orchestrator.ts`

- Text sources (Google Places, Foursquare, Yelp, web search) get every query. Structured sources
  (OSM) get one task per niche and area.
- Concurrency is bounded globally (4) and per provider (2). Each provider also has its own rate
  limit, retries and circuit breaker (see [providers.md](providers.md)).
- The job stops scheduling new queries once it has **3 × quantity** unique records, when the
  per-job call budget runs out, or when you pause or cancel.
- A failing provider changes only its own status (`partial` / `failed` / `circuit_open`). An
  authentication failure (401/403) disables that provider for the rest of the job.
- Every raw hit is stored as a `SourceRecord` with provenance (provider, provider record ID,
  fetched-at, retention expiry) and linked to the query that found it (`QueryHit`, with rank).

## 3. Merging: entity resolution

`src/engine/resolution/entity-resolution.ts`. The rule: **never merge without enough
evidence.**

Records, including companies already in your database, are grouped with union-find over
blocking keys (domain, phone, address, first distinctive name token, geo cell). Pairs are scored
as follows. A score of ≥ 0.8 merges:

| Evidence | Score |
|---|---|
| Same official website domain | 0.90 |
| Same valid phone, plus a similar name (≥ 0.6), < 250 m apart, or the same address | 0.88 |
| E-mail domain matches the other's website or e-mail domain, with name similarity ≥ 0.5 | 0.80 |
| Name similarity ≥ 0.90 and < 150 m apart | 0.85 |
| Name similarity ≥ 0.85 and same street address | 0.85 |
| Name similarity ≥ 0.93, same postcode, < 600 m | 0.80 |
| Generic name (e.g. "Dental Clinic"): only ≥ 0.95 plus identical address plus < 60 m | 0.80 |

Hard blocks: **two different official domains**, different cities (unless the score is at least
0.9), more than 2 km apart without website or phone evidence, and a phone shared by three or more
clearly different names (a call centre or booking line). A union that would put two different
domains or two existing companies into one cluster is refused. Names are normalised first:
diacritics removed, legal forms (`sp. z o.o.`, `GmbH`, `s.r.o.`, `LLC`, …) stripped, then
compared with Jaro-Winkler plus token-set similarity.

The merged company takes each value from the most trusted source (import > Google > Foursquare
= OSM > Yelp > web search) and keeps **all** source records. When sources disagree on the phone,
website, address or open/closed status, the conflict is stored as a `Discrepancy` with each
value, its sources and the observation times. It is shown on the lead and listed in Today →
Needs review. Conflicts are never resolved silently.

## 4. Verifying: status, freshness, exclusions

- **Freshness** (`src/engine/freshness/freshness.ts`). The newest dated signal (source fetch,
  website verification or analysis) gives a base score: ≤ 7 days 100, ≤ 30 days 80, ≤ 90 days
  55, ≤ 180 days 35, older 15. Two or more independent sources add 10. A source reporting the
  business as temporarily closed subtracts 30; permanently closed sets the score to 0. Each
  conflict subtracts 5 (at most 20). Labels: fresh ≥ 85, recent ≥ 65, aging ≥ 40, stale.
  `first_seen`, `last_seen`, `last_verified`, source and source timestamp are stored per company.
- **An unreachable website is not a closed business.** It is recorded as an observation only.
- **Exclusions** are kept with their reason, never silently dropped: permanently closed, your
  existing clients, previously contacted, excluded industries, do-not-contact, and "website
  only" / "public contact only" filters.

## 5. Website discovery

`src/engine/discovery/website-discovery.ts`

1. **Candidates** come from the sources' website fields. Web search is consulted only if no
   source candidate survives, to save cost.
2. **Rejected outright**, with the reason logged: social networks, review sites, maps, booking
   platforms (Booksy, ZnanyLekarz, Doctolib, …), delivery, marketplaces, business directories,
   link-in-bio pages, Wikipedia, search engines. Free-hosting subdomains (`*.wixsite.com`, …) are
   accepted but flagged.
3. **Ranking.** Source weight (Google/import 0.6, Foursquare/OSM 0.55, Yelp 0.3, search 0.25),
   plus 0.2 if two sources agree, plus how well the domain matches the name.
4. **Verification.** The top three are fetched (SSRF-guarded) and checked for the company name
   (+0.45), phone (+0.4), street (+0.15) and city (+0.05). Parked, for-sale and "under
   construction" pages are rejected.
5. **Decision.** Accept if `0.5·prior + 0.5·verification` is at least 0.3. A candidate found only
   by search needs 0.45 and on-page evidence of at least 0.4. If a listed site cannot be reached,
   the result is `unreachable`, not "no website". Otherwise the result is **"No official website
   found"**, together with the full log of what was checked and why each candidate was rejected.

## 6. Analysing: live website analysis

`src/providers/website/analyzer.ts` and `src/engine/analysis/*`. For cost control, only the most
promising ~1.5 × quantity sites are analysed; analyses newer than `REANALYZE_AFTER_DAYS` are
reused.

- **HTTP checks**: HTTPS, the HTTP→HTTPS redirect, the redirect chain, headers (HSTS,
  compression), `robots.txt` (honoured), sitemap, soft-404, homepage status.
- **Real Chromium**, one isolated context per viewport: desktop 1440×900, tablet 820×1180,
  mobile 390×844 @2x. Viewport and full-page screenshots are taken at each size. The mobile run
  tests the menu toggle; the desktop run tests keyboard focus visibility. Up to
  `ANALYSIS_MAX_PAGES` internal pages (contact, services, about, pricing) are visited if
  robots.txt allows, and links on analysed pages are checked.
- **Collected in-page**: meta tags, headings, structured data, links, images (size, alt, lazy
  loading), forms and labels, CTAs and their position relative to the fold, tap-target sizes,
  text size, horizontal overflow, overlapping text, overlays, contrast samples, landmarks, legacy
  markup, the technology stack, and lab performance (TTFB, DCL, load, LCP, CLS, long tasks,
  transfer size, third-party weight).
- **Findings** (`src/engine/analysis/checks.ts`, about 90 codes across technical, responsive,
  performance, SEO, accessibility, UX and visual categories). Each finding has a severity,
  confidence, kind (`observed` / `measured` / `ai_observation`), source, page, viewport and
  **evidence items**: a selector, a value, a screenshot, a network entry or a text excerpt.
  Positive findings ("HTTPS OK", "Structured data OK") are recorded too, so the audit can say
  what works. Example (`ux.cta_below_fold_mobile`): *"On a 390px phone screen the first
  call-to-action ("Umów wizytę") appears 1240px down, beyond the first 844px."* Its evidence is
  the mobile screenshot plus the element text and its measured offset.
- **Performance numbers are lab measurements from one load.** Lighthouse scores appear only if
  Lighthouse actually ran (`LIGHTHOUSE_ENABLED`); otherwise the audit says it did not.
- **AI visual observations** (optional) are stored separately as `ai_observation` and labelled
  as subjective.
- **History.** Each analysis is a snapshot with a fingerprint and content hash. The next analysis
  records a diff: issues fixed, issues added, and "redesign suspected" when the fingerprint
  changes a lot. This drives "why now" signals.

## 7. Contacts

`src/engine/contacts/*`. Only public business contacts are used: e-mails shown on the site as
text or `mailto:`, `tel:` links and visible phone numbers, contact forms, social links, and the
sources' listed phone, e-mail and socials.

| Status | Rule |
|---|---|
| verified | published on the official website, or the same phone from two or more independent sources |
| probable | from one business listing, not seen on the website |
| unverified | only from web search, or the e-mail domain has no MX record |

Never done: guessing addresses (`firstname@domain`), de-obfuscating addresses the owner
deliberately hid, or SMTP mailbox probing. Role addresses (`info@`, `recepcja@`) are
preferred; addresses that look personal are flagged so you can handle them with GDPR care.

## 8. Qualifying and reporting

These stages cover service matching, Lead Fit, priority, sales potential, decision intelligence
and portfolio matching; see [lead-scoring.md](lead-scoring.md). If requested, the reporting
stage drafts audits for the top leads, using templates only (AI only on demand).

## Results

The results page and `GET /api/search-jobs/:id/results` show the leads found by this job, sorted
by priority, with counts that come from the job's own rows: found, valid, excluded, with and
without a website, analysed, failed analyses, per-priority counts, contact-ready, and duplicates
merged.
