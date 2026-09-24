# Final review

State of the system at the end of this build: what exists, how it was verified, what it costs,
what is safe, what is still weak and what to do next. It is written for someone deciding whether
to rely on the tool every morning.

## 1. What is implemented

**Workflow.** Niche + city + country + service + quantity (form, natural-language command in
EN/RU/UK/PL, or the command palette) → search strategy → multi-source fan-out → merge and
deduplication with provenance and conflict reporting → freshness and exclusions → official
website discovery with a logged verdict per candidate → live analysis in Chromium (desktop,
tablet, mobile, internal pages, HTTP and link checks) → evidence-backed findings → public
contacts with verified/probable/unverified status → service matching (primary, secondary, do
not recommend) → transparent Lead Fit and priority with reasons → chance of sale (heuristic,
or a calibrated model once your own data allows) → decision intelligence (why this lead, why
now, what to offer, what to mention, what not to claim, best channel, pain points, and
KNOW/OBSERVED/INFER/DON'T KNOW) → personalised audit (HTML/PDF/MD/JSON) → outreach drafts in
4 tones and 5 languages with a claims linter → CRM (stages, activities, follow-ups, outcomes) →
learning (outcome model, outcome insights, query-template yield).

**Product surfaces.** Today (rule-based recommended actions over real CRM data), New search, Job
results (live stages, counts, sources, strategy log, queries, pause/resume/cancel/retry), Leads
table (filters, sorting, bulk actions, keyboard navigation, CSV/JSON export), Lead detail,
CRM board with drag and drop, Campaigns, Saved searches (daily schedule; the scheduler never
sends anything), Dashboard (real data, sample sizes shown), Learning, My Business (profile,
services, portfolio, re-qualify), Import, Settings (sources, keys, usage, AI budget),
Onboarding (5 steps), command palette and keyboard shortcuts, light and dark themes,
responsive down to 390px.

**Engineering.** Provider abstraction for 6 sources, 2 web search engines, a geo provider and
an AI provider. Resilient HTTP (timeouts, retries, backoff, Retry-After, rate limits,
cancellation, size caps). Circuit breakers, response cache, per-job budgets, monthly AI budget.
Database job queue with leases, heartbeats, retries and stale-lease recovery; a separate worker
process with a bounded browser pool. SQLite for development, PostgreSQL for production (one
schema, generated PostgreSQL schema and migrations). Session auth, CSRF protection, rate limits,
encrypted secrets, SSRF guard for every fetch and every browser request, CSP. Retention purge
and per-lead data erasure. Dockerfile and Compose stack.

## 2. How it was verified

| Check | Result |
|---|---|
| `npm run lint` (ESLint, zero warnings allowed) | clean |
| `npm run typecheck` (server + web, strict) | clean |
| `npm test` — 12 unit + 4 integration files | **159 / 159 passed** (~37 s) on SQLite |
| `npm run test:pg` — same suite on **PostgreSQL 16** through the real migrations | **159 / 159 passed** |
| `npm run test:e2e` — Playwright: setup → NL search → results → lead → audit → outreach → mark contacted → CRM → Today/Dashboard, plus a 390px phone-layout check on 10 pages | **2 / 2 passed** |
| `npm run build` | SPA + server/worker/CLI bundles |
| Production mode (`NODE_ENV=production node dist/server/index.js` + worker) | health OK, SPA served, security headers, setup requires `SETUP_TOKEN` |
| Docker Compose (PostgreSQL, migrations, API, worker) | built and run: API healthy, worker processing, CSV import processed end to end, audit PDF rendered by **sandboxed** Chromium (non-root) |
| Load (3,000 leads, 24,000 findings, SQLite) | lead list 7 ms · filtered list 6 ms · Today 59 ms · CRM board 41 ms · dashboard 179 ms · full CSV export 615 ms |

What the integration tests cover concretely:

- **Pipeline** against mock Google Places, Nominatim and Overpass plus three live fixture
  websites: 8 found → 6 companies (2 duplicates merged with provenance), the permanently closed
  business excluded, a booking-platform URL rejected as a website (→ "new business website"
  offer), a website verified through the phone number printed on it, a phone conflict surfaced
  as a discrepancy, and findings with evidence plus screenshots for 3 viewports. No Lighthouse
  data is invented, and every e-mail stored is present in the fixture HTML. The outdated site is
  ranked above the modern one with "website redesign" as the primary service; the audit and a
  Polish outreach draft pass the linter. Also: a second run creates no duplicates, a Google
  outage fails over to the other sources, and pause/resume/cancel checkpoints work.
- **API**: first-run setup, cookie flags, CSRF and cross-origin rejection, validation, login,
  the search pause/cancel/retry state machine, the CRM flow (stages, follow-ups, activities,
  outcomes, contact-time snapshot), manual contact validation, filters, CSV formula injection,
  export of more than 1,000 leads, erasure, secrets never returned, screenshot path traversal,
  logout.
- **Queue, learning, import, retention**: priority claim, no double claim under concurrency,
  backoff and permanent failure, stale-lease requeue; model training (activates only if it
  beats the base rate), insufficient-data path; CSV/JSON mapping and sanitisation, import job
  merge; retention purge including the raw payload, rebuilt company fields and expired
  listing-only contacts.
- **Analyzer sandbox**: an analysed page cannot open a WebSocket to a local service. This
  test fails without the fix.

## 3. Problems found and fixed during the review

| Area | Problem | Fix |
|---|---|---|
| Security | Analysed pages could open **WebSockets** to internal services (request interception doesn't cover them) | WebSockets refused per context, WebRTC restricted; regression test |
| Security | Chromium ran **without its own sandbox** (Playwright default) | `BROWSER_SANDBOX` option; enabled in Docker with Playwright's seccomp profile; verified as uid 1001 |
| Security | `X-Forwarded-For` was trusted in every production deploy, so the login rate limit could be bypassed | explicit `TRUST_PROXY` (default off); Compose sets 1 hop |
| Compliance | Retention purge left the **raw provider payload** in place, and provider-only company fields were kept forever | payload cleared; rating, reviews, price and coordinates rebuilt from records still in retention; test |
| Privacy | No way to delete a company's data | *Delete data* / `DELETE /api/leads/:id` (rows and screenshot files); test |
| Correctness | CSV/JSON export **crashed** with more than 999 leads (Prisma chunked `IN` + unselected `orderBy` column) | column selected; regression test with 1,100 leads |
| Correctness | "Mobile issues → opportunity for *website maintenance*": pain points were paired with an unrelated service | a pain point names only a service whose evidence covers it; unit tests |
| Correctness | `stripDiacritics` lowercased `Ł`/`Ø`/`Æ` | fixed; unit test |
| Config | `JOB_MAX_LEADS` was declared but not enforced | enforced, and logged in the job |
| UX | On phones, several page grids sized columns to their content, so panels ran off the screen (Today, Learning, Dashboard, forms) | base single-column template on all 29 responsive grids; E2E phone-layout test (fails before the fix) |
| Testing | Integration tests depended on live DNS MX lookups | `EMAIL_MX_CHECK` setting (also useful offline) |

## 4. Providers

| Provider | Status |
|---|---|
| OpenStreetMap (Nominatim + Overpass) | implemented; works without a key; tested against a mock of both APIs |
| Google Places API (New) | implemented (text search with field mask, pagination, details); tested against a mock |
| Foursquare Places (new API + legacy v3) | implemented; not exercised live |
| Yelp Fusion | implemented (never used as a website source; 24 h retention); not exercised live |
| Brave Search, Google Programmable Search | implemented as web-discovery engines; Brave tested against a mock |
| CSV / JSON import | implemented and tested through the API |
| Anthropic (visual observations, audit prose, outreach) | implemented with structured output, refusal handling, cache and budget; not exercised live (no key in the build environment); every feature has a non-AI path |
| Lighthouse | optional hook; only used if the `lighthouse` package is installed; not exercised |

**Important:** no live calls to the paid providers or to the public OSM servers were made while
building this. The request and response mappings follow each provider's documented format and
are checked against mocks. On your first real search, watch Settings → Sources and the job's
provider panel. Any mapping problem shows up there as a provider error, not as silent bad data.

## 5. Costs

- Without keys: $0. OSM, the analysis, scoring, template audits and template outreach are free.
- Paid APIs: at most one call per query per source, 6–40 queries depending on quantity, a hard
  cap of `MAX_PROVIDER_CALLS_PER_JOB` (300) per job, and caching (12 h – 30 days).
- AI: optional, capped by `AI_MONTHLY_TOKEN_BUDGET` (3M tokens by default), cached for 30 days,
  and never required.
- Compute: one Chromium per worker. Measured about 14 s for a 20-lead search with 3 live
  analyses on local fixture sites; real sites take roughly 5–15 s each at concurrency 2.
  Details: [cost-control.md](cost-control.md).

## 6. Security posture

Implemented and tested: single-owner auth with a setup token, scrypt, hashed session tokens,
strict cookies, CSRF header plus origin check, rate limits with explicit proxy trust, zod
validation everywhere, encrypted secrets that are never returned or logged, CSP and helmet
headers, escaped HTML exports, CSV injection guard, path-safe media, an SSRF guard for HTTP
(every redirect hop, guarded connect) and for the browser (every request, WebSockets blocked,
optional Chromium sandbox), robots.txt, no guessed contacts, retention purge, erasure, and no
sending. Residual risks: DNS rebinding against the browser, a Chromium zero-day, no 2FA or
roles, an in-memory rate limiter. Mitigations are in [security.md](security.md).

## 7. Known issues and limitations

1. **Live provider behaviour is unverified** (see §4). Expect to adjust field mappings after the
   first real runs, especially Foursquare's new API and Yelp coverage outside the US.
2. **Niche taxonomy** covers about 34 niches. Other niches work with the raw term only (lower
   recall, no OSM tags); add them to `src/domain/taxonomy.ts`.
3. **Built-in districts** exist for Warsaw, Kraków, Wrocław, Prague and Berlin. Other cities get
   districts from OSM only when the request is over 40 leads and OSM is enabled.
4. **Outreach languages**: EN, PL, RU, UK, DE. Other countries' drafts fall back to English
   (the AI mode can translate).
5. **Company size** is a proxy (review count, number of locations). No firmographic data source
   is integrated.
6. **Performance numbers are single lab loads** from the worker's location, not field data.
   Lighthouse is optional and off.
7. **One user.** There are no roles, no teams and no 2FA.
8. **Screenshots are on local disk** (`DATA_DIR`). Several API instances need shared storage.
9. **Chromium sandbox** is off by default outside Docker, because it needs a non-root user with
    user namespaces.
10. The query-template statistics are computed on the fly over all past queries. That is fine
    for thousands of queries, but should become an aggregate table at a larger scale.

## 8. Next improvements (in order of value)

1. First real runs with your keys on 2–3 cities; fix any mapping issues they reveal; record the
   real cost per 100 leads.
2. Record outcomes from the first 40+ contacted leads so the model and the template-yield loop
   have data (Learning shows progress).
3. A suppression list, so erased or do-not-contact businesses are not re-added by later
   searches (matched by domain and phone).
4. More niches and district lists for your target markets; outreach phrases in more languages.
5. An optional Lighthouse or PageSpeed Insights integration for pages that justify it (top
   leads only).
6. 2FA (TOTP) and a second role (assistant) if more people use the tool.
7. Object storage for screenshots and a shared rate-limit store for multi-instance deployments.

## 9. Self-audit: "Could I personally use this every morning to find better clients?"

**Yes, with one condition.** Today gives a morning list built from real data: overdue
follow-ups, replies waiting, new high-priority leads without a draft, stale proposals, and
leads that need review. Each item links to the exact leads. A search produces a ranked list
where every position says *why*: the evidence, the screenshots, what to offer and what not to
claim. The audit and the first message take one click each and don't overclaim. Nothing is
sent without you, and every result you record makes the next ranking better.

The condition is §4 and §7.1: the system has only been exercised against mocks and local
fixture websites. The first week of real use should include watching provider errors and
sanity-checking the top 10 leads of each search by hand. The tool makes that easy, because
every score opens to its evidence.
