# Cost control

Three things cost money or machine time: **paid place/search APIs**, **AI tokens** and
**browser time**. The defaults keep all three small, and every limit is visible in Settings.

## What a search spends

| Step | Cost driver | Control |
|---|---|---|
| Planning | free | The number of queries depends on quantity: ≤20 → 6, ≤50 → 10, ≤100 → 16, ≤300 → 28, otherwise 40 |
| Discovering | one call per query per text source (Google Places may page: up to 3 pages of 20) | stops at 3 × quantity unique records; **`MAX_PROVIDER_CALLS_PER_JOB`** (default 300) hard cap; cache |
| OSM | one Overpass call per niche and area, not per query | structured mode; 3-day POI cache, 30-day geocoding cache |
| Website discovery | web search **only** when no source lists a usable website | cached 3 days |
| Analysis | Chromium time: 3 viewports + up to `ANALYSIS_MAX_PAGES − 1` internal pages + link checks | only the most promising **1.5 × quantity** sites; results newer than **`REANALYZE_AFTER_DAYS`** (14) are reused |
| AI visual observations (optional) | one multimodal call per analysed site | `AI_VISUAL_ANALYSIS`, a per-search toggle, cache, monthly budget |
| Audits / outreach | free (templates) | AI only when you click "with AI" |

The job page's **Sources** panel shows calls, records and errors per provider for that job. The
strategy log records budget exhaustion, early stops, skipped analyses and web-search lookups.

## Caching (`CacheEntry`)

| Namespace | TTL |
|---|---|
| Google Places search / details | 12 h |
| Foursquare search / details | 24 h |
| Yelp search / details | 12 h (terms allow ≤ 24 h) |
| Nominatim geocoding, Overpass subdivisions | 30 days |
| Overpass POIs | 3 days |
| Brave / Google CSE | 3 days |
| AI responses (keyed by prompt and image hashes) | 30 days |

Repeating a search within these windows costs nothing for cached calls; cache hits are counted
in `ProviderUsage.cacheHits`. The daily maintenance job removes expired entries. Caching never
extends past a provider's retention policy.

## Incremental work

- **Deduplication across runs.** New records are matched against existing companies first, so a
  second run over the same area creates no duplicates (tested) and re-analyses nothing that is
  still fresh.
- **Re-analysis** happens only when an analysis is older than `REANALYZE_AFTER_DAYS` or you
  click **Analyze**.
- **Re-qualification** after you change services or weights runs code only. There are no API or
  AI calls.

## AI

- Off unless `ANTHROPIC_API_KEY` is set; `AI_PROVIDER=none` disables it completely.
- The technical analysis, scoring, audit and outreach all work without AI. AI is used for
  interpretation and writing only.
- **`AI_MONTHLY_TOKEN_BUDGET`** (default 3,000,000 tokens). Every call's input and output tokens
  are recorded per day in `ProviderUsage`. Once the month's total reaches the budget, AI calls
  are refused with a clear message and everything falls back to templates.
- Output caps per task: visual analysis 8k tokens, audit 16k, outreach 4k.
- `AI_EFFORT` (`low` … `max`) trades quality for cost on models that support it.
- Settings shows this month's tokens against the budget.

## Browser resources

- One Chromium process per worker, with at most `BROWSER_POOL_SIZE` contexts at a time.
  `ANALYSIS_CONCURRENCY` sites run in parallel per job. Every context is closed after use, and
  the browser is relaunched if it crashes.
- Heavy pages are bounded: navigation timeout `ANALYSIS_TIMEOUT_MS`, screenshot timeouts,
  limited full-page screenshot height, capped network and console logs, response size caps for
  HTTP checks.
- Measured on the local fixture sites: a 20-lead search with 6 companies and 3 live analyses
  (3 viewports each) takes about 14 s end to end. Real websites are slower; budget roughly
  5–15 s per site at concurrency 2.

## Estimating a job before you run it

For a request of *N* leads with *S* text sources configured:

```
queries    ≈ budget(N)                 (6 … 40)
API calls  ≤ queries × S (+ Google pagination) , hard-capped by MAX_PROVIDER_CALLS_PER_JOB
analyses   ≤ 1.5 × N  (minus fresh ones)
AI calls   ≤ analyses (only if visual AI is on)
```

Check your providers' current price lists; they change, so no prices are hard-coded here. The
Google Places field mask we request includes website, phone and rating, which puts requests in
Google's higher "Text Search" pricing tier. Removing fields in
`src/providers/google-places/index.ts` lowers the tier but loses signals.

## Where to see usage

- **Settings → Usage:** calls, failures and cache hits per provider per day (last 30 days), and
  AI tokens this month against the budget.
- **Job page → Sources:** per-job calls, records and errors.
- **Logs:** JSON lines with `provider`, `request`, `status`, `latencyMs`, `attempt` and `jobId`.
