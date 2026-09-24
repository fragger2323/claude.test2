# Agency Intelligence OS — Architecture

> Personal, evidence-first business-development operating system for a web studio.
> Input: *niche + location + country + service + quantity* → output: a ranked, explained,
> evidence-backed list of companies with audits, outreach drafts and a CRM pipeline.

## 1. Guiding principles

1. **Evidence first.** Every conclusion that reaches the UI carries `source`, `timestamp`,
   `evidence` and `confidence`. The UI always separates
   **WHAT WE KNOW** (source data) · **WHAT WE OBSERVED** (code-measured facts) ·
   **WHAT WE INFER** (interpretations, AI observations) · **WHAT WE DON'T KNOW** (gaps).
2. **No fabrication.** No guessed e-mails, no invented probabilities, no fake metrics,
   no "company is losing clients" claims. Missing data is shown as missing.
3. **Provider independence.** Business logic talks to interfaces (`LeadSourceAdapter`,
   `WebSearchProvider`, `GeoProvider`, `AiProvider`), never to a concrete API.
   Every provider is optional; failure of one never breaks a job.
4. **Legal sources only.** Official APIs, public websites (robots.txt respected),
   user imports. No CAPTCHA/auth/paywall bypass, no private data, no mass sending.
5. **Code before AI.** Deterministic code does all measurable checks. AI is used only
   for interpretation/writing, is optional, cached and budgeted.
6. **Learn from real outcomes.** Heuristic priority until enough of the user's own
   outcomes exist; then a calibrated model with uncertainty, sample size and version.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict, ESM), Node ≥ 22 | one language for API, worker, UI |
| API | Fastify 5 + zod validation | fast, typed, first-class hooks for auth/rate-limit |
| DB | Prisma 6 — SQLite for local dev, PostgreSQL for production | same schema, generated PG schema + PG migrations |
| Jobs | DB-backed job queue (lease-based) + separate worker process | no Redis needed; pause/resume/cancel/retry; swappable |
| Browser | Playwright (Chromium) behind a bounded browser pool | live multi-viewport analysis |
| AI | Anthropic Claude via `@anthropic-ai/sdk` behind `AiProvider` | optional; cached; budgeted |
| UI | React 19 + Vite + React Router + TanStack Query/Table + Tailwind 4 + cmdk | dense, fast internal tool |
| Tests | Vitest (unit + integration) · Playwright Test (E2E) | mock provider server + fixture websites, no network needed |

## 3. Process topology

```
┌─────────────┐   HTTP/JSON    ┌────────────────────┐        ┌───────────────┐
│  Web UI     │ ─────────────▶ │  API (Fastify)     │ ─────▶ │  Database      │
│  (SPA)      │ ◀───────────── │  auth · rate limit │ ◀───── │  SQLite / PG   │
└─────────────┘   polling      └────────────────────┘        └───────▲───────┘
                                                                      │ jobs (lease)
                                ┌────────────────────┐                │
                                │  Worker            │ ───────────────┘
                                │  job runner        │ ──▶ Source providers (APIs)
                                │  scheduler (cron)  │ ──▶ Browser pool (Playwright)
                                │  browser pool      │ ──▶ AI provider (optional)
                                └────────────────────┘
```

The API never runs long work inline: it enqueues a `Job`; the worker claims it with a
lease (`lockedUntil`), heartbeats, and writes progress to `SearchJob`. The UI polls.
In single-box deployments the API can also host the worker (`RUN_WORKER_IN_PROCESS=true`).

## 4. Source code layout

```
src/
  config/          env parsing + secret validation (zod)
  lib/             logger, resilient http client, rate limiter, concurrency, retry,
                   url/phone/text normalization, SSRF guard, crypto, csv
  db/              Prisma client + JSON helpers
  domain/          shared types: Finding, Evidence, Confidence, CRM stages, taxonomy
  providers/
    types.ts       LeadSourceAdapter, WebSearchProvider, GeoProvider, AiProvider
    registry.ts    builds the enabled provider set from config (+ health / circuit breaker)
    google-places/ foursquare/ yelp/ osm/   business & places sources
    search/        Brave Search, Google Programmable Search → web discovery adapter
    import/        CSV / JSON import adapter
    website/       fetcher, browser pool, live analyzer (page collectors + checks)
    ai/            Anthropic adapter, disabled adapter, request cache
  engine/
    strategy/      Search Strategy Engine (query variations, languages, districts)
    orchestrator/  Source Orchestrator (fan-out, limits, retries, provenance)
    resolution/    Entity resolution + dedup + discrepancy detection
    freshness/     freshness scoring and verification rules
    discovery/     official-website discovery and classification
    analysis/      analysis service, finding catalog, snapshots & diffs
    contacts/      public contact discovery and verification status
    fit/           service matching, Lead Fit, priority, sales potential, decision intel
    portfolio/     portfolio matching
    reports/       audit + outreach generation (template + optional AI) and linting
    learning/      feature snapshots, logistic model, calibration, search-quality loop
    command/       natural-language command parsing
    pipeline/      the search job pipeline (stage machine)
  jobs/            queue, worker entry, handlers, scheduler
  server/          Fastify app, auth, routes
  web/             SPA
```

## 5. The pipeline (one `SearchJob`)

```
planning → discovering → merging → verifying → website_discovery → analyzing
        → contacts → qualifying → reporting → completed
```

| Stage | What happens | Persisted |
|---|---|---|
| planning | Strategy engine expands niche×language×location segments into `SearchQuery` rows, ordered by historical yield | `SearchQuery` |
| discovering | Orchestrator fans queries out to every enabled source with per-provider rate limits, concurrency caps, retries w/ backoff, timeouts, cancellation; circuit breaker skips unhealthy providers | `SourceRecord` (+ provider call log) |
| merging | Entity resolution clusters records (provider id, domain, phone, name+geo, name+postcode), creates/updates `Company` + `Location`, records conflicts | `Company`, `Location`, `Discrepancy` JSON, `Lead`, `CampaignLead` |
| verifying | Business status, freshness, user exclusions (existing clients, contacted, industries) — excluded leads are kept with a reason, never silently dropped | `CampaignLead.excludedReason` |
| website_discovery | Candidates from sources + web search; directories/social rejected; homepage fetched and matched against name/phone/address | `Website` (+ `discoveryLog`) |
| analyzing | Playwright live analysis (desktop/tablet/mobile) + fetch checks; incremental (skips fresh analyses) | `Analysis`, `Finding`, `Screenshot` |
| contacts | Public contacts from site + sources; verified/probable/unverified | `Contact` |
| qualifying | Service matching, Lead Fit components, priority, sales potential, decision intelligence, portfolio match | `Recommendation`, `Lead.*` |
| reporting | Optional audit drafts for top leads (deterministic by default; AI only on demand) | `Audit` |

Every stage is idempotent and checkpointed, so *pause → resume* and *retry* continue
where they stopped. Counts shown on the results page are computed from the job's own rows.

## 6. Data model (summary — full list in `docs/data-model.md`)

`Company` ─┬─ `Location` (1..n)
           ├─ `Website` (official site + confidence + discovery source)
           │     └─ `Analysis` (history of snapshots) ─┬─ `Finding` (evidence-backed)
           │                                           └─ `Screenshot`
           ├─ `Contact` (type, value, source, source_url, last_verified, status)
           ├─ `SourceRecord` (raw normalized provider record, provenance, retention)
           └─ `Lead` (CRM record) ─┬─ `Recommendation` (primary/secondary/do-not)
                                   ├─ `Audit`, `Outreach`, `Activity`, `FollowUp`
                                   └─ `Outcome` (+ feature snapshot at contact time)

`Campaign` ─ `SearchJob` ─ `SearchQuery`;  `CampaignLead` joins campaigns and leads.
`Service`, `PortfolioProject`, `BusinessProfile`, `SavedSearch`, `ModelRun`,
`Job`, `ProviderHealth`, `ProviderUsage`, `CacheEntry`, `ProviderSecret`, `User`, `Session`.

Portability rules: no DB enums (validated string unions in TS), JSON columns via Prisma
`Json` (supported on SQLite and PostgreSQL), no raw SQL in business logic.

## 7. Scoring (see `docs/lead-scoring.md`)

Lead Fit is a **transparent sum of explained components** — Website Need, Service Fit,
Business Fit, Contactability, Data Freshness, Technical Opportunity, Commercial Relevance —
each with factor lists pointing at evidence. Priority (Very High/High/Medium/Low/Excluded)
is derived by explicit rules and always returned with "why". Sales potential is
**Mode A** (High/Medium/Low heuristic, labelled as such) until a `ModelRun` trained on the
user's own outcomes passes sufficiency and calibration thresholds (**Mode B**: probability +
interval + sample size + model version + trained date).

## 8. Cross-cutting concerns

* **Resilience** — `lib/http.ts`: timeout (AbortController), retries with exponential backoff
  + jitter on 429/5xx/network, `Retry-After`, per-provider token bucket, cancellation signal,
  structured logs with secrets redacted. `providers/health.ts`: rolling success/failure stats
  and a circuit breaker per provider.
* **Cost control** — DB cache for provider responses (per-provider TTL respecting ToS),
  AI response cache keyed by prompt hash, incremental re-analysis, per-job call budgets,
  monthly AI token budget, usage counters (`ProviderUsage`).
* **Security** — secrets only in env or AES-256-GCM encrypted in DB (never returned to UI),
  session auth with scrypt password hashes, SameSite=Strict cookie + custom-header CSRF guard,
  rate limiting, zod validation on every route, SSRF guard for website fetching, CSV
  formula-injection-safe exports, sanitized imports, CSP via helmet.
* **Observability** — pino JSON logs with `provider`, `request`, `status`, `latencyMs`,
  `attempt`, `jobId`; AI request/failure logs; provider health surfaced in the UI.
* **Compliance** — provider data-retention policies (e.g. Google/Yelp content TTL) enforced by
  a purge job; OSM attribution; outreach is draft-only, sent manually by the user.

## 9. Implementation plan (executed in this order)

1. Tooling, config, Prisma schema (SQLite) + generated PostgreSQL schema/migrations.
2. Core libs (http/retry/rate-limit/normalization/SSRF/crypto) with unit tests.
3. Provider interfaces + adapters (Google Places, Foursquare, Yelp, OSM/Nominatim/Overpass,
   Brave, Google CSE, CSV/JSON import, Anthropic AI).
4. Engines: strategy → orchestrator → resolution → freshness → website discovery →
   analyzer → contacts → fit/service matching/priority → decision intel → audit/outreach →
   learning/search-quality → command parser.
5. Job queue, worker, scheduler, pipeline.
6. API routes + auth.
7. UI: onboarding, Today, New search/command palette, job results, lead table, lead detail,
   CRM board, campaigns, saved searches, dashboard, learning, My Business, settings.
8. Tests: unit, integration (pipeline against mock providers + fixture sites), E2E.
9. Docs, security/performance/UX review, final self-audit (`docs/final-review.md`).
