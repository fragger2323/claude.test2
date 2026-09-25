# Final review

Updated after an **adversarial review** (2026-09-25). The question was: *"Tomorrow morning I run
it to find 100 potential clients for my web studio. What will stop it from working?"* Every
suspicion was checked with code reading **and** an experiment: hostile test websites, realistic
dedup pairs, real-world URL shapes, and a full 100-lead run against 150 websites. What was
broken is listed below with the fix and the test that now guards it.

**Status, honestly:** every automated check passes (see §4), and the problems found were fixed.
The system is **not** called "production-ready" here, because it has still never talked to the
real Google, Foursquare, Yelp, Brave, public OpenStreetMap or Anthropic APIs; every run used
mocks and local websites (§6). Treat the first week of real use as the final acceptance test.

## 1. The 32 questions: verdict before → after

| # | Question | Before the review | Now |
|---|---|---|---|
| 1 | Several sources? | Yes, fan-out to every configured source with dedup across them. With no keys it is OSM only, and the UI didn't say what that means. | Same fan-out. The search form now says when only one source is active and when web search is missing, and what that implies. |
| 2 | Dedup quality | Good on 9 realistic pairs, but **a shared phone merged two clinics 9.5 km apart** ("Centrum Implantologii Wiśniewska" + "…Nowakowski"), found by the scale run. | Similarity on *distinctive* name words only; >2 km apart never merges without the same domain. 10 realistic cases are regression tests; scale run: 180/180 companies. |
| 3 | Directory pages confused with companies? | **Yes.** News sites, classifieds, job boards, gov portals, `cylex-polska.pl`, `kliniki.pl`, `moment.pl` … passed as official websites; listicle titles became company names ("ranking 2025", "zestawienie"). | Domain rules extended (media, jobs, government, classifieds, keyword directories); web-search results must look like a homepage and a single business. Tests. |
| 4 | Freshness | **False.** It used the time *we* fetched the data, so an OSM entry last edited in 2016 showed "Fresh 100, verified today". | Only a live website check, a maintained listing (Google/Foursquare/Yelp, capped at 85) or the source's own edit date count (OSM `timestamp` now stored). Undated data shows "age unknown". |
| 5 | Sites checked live? | Yes (Chromium, 3 viewports). | Yes, and now bounded and honest about what it could not see (6, 11, 16). |
| 6 | Fabricated findings? | **Yes, four ways:** bot-challenge pages analysed as the site; "phone not tappable" triggered by years, tax IDs and bank numbers; "HTTPS missing" on a timeout or on a 403; console errors caused by our own sandbox counted as the site's. Internal 403/429 and HEAD-only 404 counted as broken links. | Challenge pages → `blocked`, no findings, no AI. Only valid phone numbers count. HTTPS "missing" only on a real transport failure. Self-inflicted console noise filtered. Links: failures confirmed by GET; 401/403/429/timeouts are "unverifiable". Hostile-site tests. |
| 7 | Fabricated e-mails? | None guessed, but **a web agency's footer address was stored as the business's "verified" e-mail**. | Credit-line addresses are ignored; on-site addresses on another organisation's domain are only "probable" with a note; free-mail stays valid. Tests. |
| 8 | False confidence? | **Yes:** without web search, every business whose listing had no website was "No official website found" → Website Need 90 → a "new website" pitch (10 of 39 in the scale run actually had a site); fetch-time freshness; bot-protected sites scored as "site is down". | New website state `unverified` (gap, "insufficient data", no pitch, *Add website* button); honest freshness; bot-protected sites exist but are "not verified". |
| 9 | Service matching tied to problems? | Yes, via problem tags and finding IDs. One flaw (fixed in the first review): pain points paired with unrelated services. | Unchanged; no service is pitched for an unverified website. |
| 10 | Background search works? | Yes with `npm run dev`. With `npm start` alone, **no worker runs and the job page said "Waiting for the worker…" forever**. | Worker heartbeat; `/api/health` reports live workers; the job page says "No worker is running" and how to start one. Test. |
| 11 | Playwright hangs? | **Yes.** A page that freezes its main thread blocked `page.evaluate` forever (test hit its 90 s limit). | Timeouts on every evaluate, a hard deadline per browser run (force-close, browser restart), a per-site budget (180 s), and remaining viewports skipped on a frozen page. The frozen page now costs ~12 s. |
| 12 | Uncontrolled concurrency? | No: global/provider/analysis/browser-context limits held. Scale run peak: 2 browser contexts, ≤ 24 requests to one site. | Same, plus per-site time budget. |
| 13 | Retries correct? | Mostly. **The circuit breaker counted every retry attempt**, so two flaky requests could take Google out for the whole job. | The breaker counts requests; every attempt is still counted as billable usage. Test. |
| 14 | Cache works? | Yes (TTL-checked, expired entries deleted). | Now covered by a direct test (hit, expiry, TTL 0). |
| 15 | Provider down? | Failover works (test: Google 503 → OSM results). | Same; with the retry fix, a brief outage no longer disables the provider. |
| 16 | Site down? | "Unreachable", not closed, but error pages (404/403) were analysed as content. | 4xx/5xx → `unreachable` (one status finding); 401/403/429/challenge → `blocked`; never "closed". |
| 17 | No contact? | Handled: priority capped at Medium, not "contact ready", "No public business contact found". | Unchanged. |
| 18 | CRM works? | Yes (stages, follow-ups, activities, outcomes; API + E2E tests). | Unchanged. |
| 19 | Feedback loop? | Outcomes → contact-time snapshot → training; query-template yield reorders future searches. | Unchanged. |
| 20 | Outcomes saved? | Yes, with features frozen at contact time (tests). | Unchanged. |
| 21 | Train qualification on my results? | **Partly.** The model (≥ 40 labelled leads, must beat the base rate) produces a calibrated chance with interval, and insights. Priority rules stay transparent heuristics (weights are configurable via the business profile API, not in the UI). | Unchanged. Stated plainly in §5. |
| 22 | Portfolio matching? | Correct: only stored facts, threshold 0.4, nothing suggested otherwise (tests). | Unchanged. |
| 23 | Search → contact-ready speed | **Slow to show anything:** scoring ran only after all analyses, so the first ranked lead appeared after **24.6 min** in the 100-lead run. | Progressive scoring: every lead is scored provisionally when analysis starts and re-scored as soon as its site is analysed. First contact-ready lead after about 2 min in the scale run (§3). |
| 24 | UI clear? | Mostly. "Waiting for the worker…" forever; raw status words; 6 empty cards on day one. | Worker warning, explained analysis statuses, "website not verified" with *Add website*, empty Today sections collapsed into one line. |
| 25 | Generic AI dashboard style? | **Yes, partly:** an "AI" logo tile and the stock indigo accent. | Neutral crosshair mark and a deep-teal accent (contrast 6.3:1 light, 9:1 dark). Purple is kept only to mark AI-generated content. |
| 26 | Security | Reviewed in the first round (WebSockets, sandbox, proxy trust, erasure). | Plus: bot protection never bypassed, bounded browser work, no AI on challenge screenshots. |
| 27 | API key leaks | None found: bundle contains only key *names*; responses show last 4 characters; logs redact query keys. | Unchanged; re-checked. |
| 28–32 | lint, typecheck, tests, build, E2E | Passing. | Passing after the fixes (§4). |

## 2. What changed in this round

| Problem | Fix | Guarded by |
|---|---|---|
| Frozen page hangs the job | `evaluateWithin` timeouts; hard deadline per browser run with force-close/restart; `ANALYSIS_SITE_BUDGET_MS`; skip viewports after a freeze | `tests/integration/analyzer-hostile.test.ts` |
| Challenge/bot pages analysed | `challenge.ts`; HTTP 401/403/429 and challenge markers → `blocked`; no findings, no AI, no "last verified"; discovery treats them as existing | hostile tests, `tests/unit/adversarial-fixes.test.ts`, `website-discovery.test.ts` |
| Fake "phone not tappable" | validated phone parsing (libphonenumber) with the business's country | hostile test (years/NIP/KRS/IBAN) |
| "HTTPS missing" on timeout or 403 | HTTPS = TLS produced any response; timeout = unknown | hostile tests |
| Broken-link false positives | GET confirms HEAD failures; 401/403/405/429/timeouts unverifiable | — (logic in `http-checks.ts`) |
| Self-inflicted console errors | filtered (blocked requests, refused WebSockets) | — |
| A frozen-page analysis (`failed`) read "Website found but not analysed yet" (found in the scale run) | reasons say the analysis failed and nothing was concluded | `adversarial-fixes.test.ts` |
| Agency e-mail as business contact | credit-line filter; foreign-domain → probable; free-mail allowed | hostile test, unit test |
| False "no website" | `unverified` website state end to end (discovery, scoring, services, decision notes, counts, filters, UI, *Add website* endpoint) | unit + pipeline + API tests |
| Fetch-time freshness | new freshness model; `SourceRecord.sourceUpdatedAt` (+ SQLite and PostgreSQL migrations); OSM `out meta` | `scoring.test.ts`, unit tests |
| Directories/news as companies | extended domain classes; homepage + single-business title rules for web search | unit tests |
| Shared-phone false merge | distinctive-name similarity; 2 km rule | 10 regression cases in `entity-resolution.test.ts`; scale run |
| Circuit breaker counted retries | per-request health, per-attempt usage | `tests/integration/resilience.test.ts` |
| No worker → silent | heartbeat, `/api/health.workers`, job-page alert | resilience test |
| Late ranking | progressive qualification during analysis | scale run |
| UI | brand mark, accent, Today, statuses, "age unknown", single-source note | E2E + phone-layout test |

## 3. The 100-lead scale run (`npm run test:scale`)

Setup: 150 generated clinic websites, each on its own loopback address, plus 30 businesses
without a site. Mocked Nominatim, Overpass (170 POIs) and Google Places (60 overlapping + 10
unique). Real worker, real Chromium, SQLite. The "after" run adds 9 hostile sites: frozen main
thread, bot challenge, never-ending response. Machine: 4 vCPU, 16 GB.

| Metric | Before fixes | After fixes (with hostile sites) |
|---|---|---|
| Job status | completed | pending |
| Total time | 24.6 min | pending |
| First ranked lead | 24.6 min (at the very end) | pending |
| First contact-ready lead | 24.6 min | pending |
| Unique companies (expected 180) | **179** (false merge) | pending |
| Leads falsely pitched "no website" | **10** of 39 | pending |
| Websites analysed / statuses | 140 completed | pending |
| Hung jobs | – (no hostile sites) | pending |
| Peak browser contexts / peak requests to one site | 2 / 24 | pending |
| Provider calls | 51 | pending |

Throughput is ~10 s per site at the default concurrency (2 browser contexts) on these local
sites. Real sites are slower, so expect roughly 20–40 minutes for 100 leads with analysis, while
ranked leads keep appearing from the first minutes. `BROWSER_POOL_SIZE` and
`ANALYSIS_CONCURRENCY` (e.g. 3–4 on a 4-core machine) trade CPU/RAM for speed.

## 4. Verification after the fixes

| Check | Result |
|---|---|
| `npm run lint` (zero warnings allowed) | pass (0 problems) |
| `npm run typecheck` (server + web, strict) | pass |
| `npm test`: unit + integration on SQLite | pass: 189/189 tests in 19 files |
| `npm run test:pg`: the same suite on PostgreSQL 16 through the real migrations (incl. the new one) | pass: 189/189; `prisma migrate deploy` applied `20260925065312_source_updated_at` |
| `npm run build` | pass (web + server bundles) |
| `npm run test:e2e`: full flow + 390 px phone layout on 10 pages | pass: 2/2 |
| `npm run test:scale` | pending (run in progress) |

## 5. What the system still cannot do (limitations)

1. **Live provider behaviour is unverified.** No request has gone to the real Google Places,
   Foursquare, Yelp, Brave, Google CSE, public OSM or Anthropic APIs; mappings follow their
   documentation and are tested against mocks. Watch Settings → Sources and the job's provider
   panel on the first runs; mapping problems show up there as errors, not as silent bad data.
2. **Without web search** (no Brave/Google CSE key), businesses whose listings have no website
   are "website not verified" and are not ranked until you add the site or configure search.
   This is deliberate: guessing would recreate the false "no website" pitch.
3. **Bot-protected sites are not analysed** (`blocked`), by design; you judge them yourself.
4. **Priority is a transparent heuristic.** The outcome model learns from your results and shows
   a calibrated chance with an interval once it beats the base rate, but it does not re-weight
   the priority rules automatically. Weights can be changed via the business profile API; there
   is no UI for it yet.
5. **Analysis takes time:** ~10 s per site locally, more on real sites; for 100 leads the full
   job takes tens of minutes (ranked leads appear progressively).
6. **Coverage:** about 34 niches in the taxonomy; built-in districts for 5 cities; outreach
   copy in EN/PL/RU/UK/DE; company size is a proxy (reviews/locations).
7. **Lab performance only** (single load from the worker's location); Lighthouse optional/off.
8. **One user, no 2FA/roles**; screenshots on local disk; in-memory rate limiter (single API
   instance).
9. **Chromium sandbox** is on in Docker, but off by default elsewhere (needs a non-root user with
   user namespaces).
10. The domain and challenge lists are heuristics. New directories or protection vendors will
    appear; add them in `src/lib/url.ts` / `src/providers/website/challenge.ts`.

## 6. Providers

| Provider | Status |
|---|---|
| OpenStreetMap (Nominatim + Overpass) | implemented, keyless; last-edit timestamps used for freshness; tested against mocks |
| Google Places API (New) | implemented; tested against mocks |
| Foursquare, Yelp | implemented; not exercised (not even against mocks in the pipeline test) |
| Brave, Google Programmable Search | implemented; Brave mocked; stricter result filtering added |
| CSV/JSON import | implemented and tested through the API |
| Anthropic | implemented (structured output, refusals, cache, budget); not exercised live; every feature works without it |

## 7. Costs and security (unchanged in substance)

- Costs: $0 without keys; paid calls capped per job (`MAX_PROVIDER_CALLS_PER_JOB`), cached
  12 h – 30 days; AI optional and budgeted. Details: [cost-control.md](cost-control.md).
- Security: auth with setup token, hashed sessions, CSRF protection, rate limits with explicit
  proxy trust, validation, encrypted secrets that are never returned or logged, CSP, escaped
  exports, CSV injection guard, SSRF guard for HTTP and the browser (WebSockets blocked, optional
  Chromium sandbox), bot protection never bypassed, bounded browser work, retention purge,
  erasure, no sending. Details and residual risks: [security.md](security.md).

## 8. Next improvements (in order of value)

1. First real runs with your keys on 2–3 cities; fix whatever mapping issues they reveal;
   record real cost and time per 100 leads.
2. Configure a web-search key (Brave is cheapest) so "website not verified" becomes "found" or
   "no website".
3. Record outcomes for the first 40+ contacted leads so the model and query ordering learn.
4. A UI for scoring weights, fed by the learning insights.
5. A suppression list (domain/phone) so erased or do-not-contact businesses are not re-added.
6. More niches, district lists and outreach languages for your markets.
7. 2FA, object storage for screenshots, and a shared rate-limit store if more people use it.

## 9. Self-audit: "Could I use this every morning to find better clients?"

**Yes, as a working draft of the morning routine, not as a finished product.** The failures that
would have hurt most on a real morning are fixed and tested:
- confident but false "no website" pitches;
- "fresh" data that was years old;
- analyses of bot-challenge pages;
- a search that shows nothing for 25 minutes;
- a job that waits forever when no worker runs;
- a frozen page that hangs everything.

Every score still opens to its evidence, and nothing is sent without you. The honest remaining
risk is §5.1: until it has run against the real APIs, the first week needs a human check of the
top 10 leads per search, and a look at the provider panel.
