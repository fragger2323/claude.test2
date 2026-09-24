# Providers

Business logic never calls a concrete API. It depends on four interfaces in
`src/providers/types.ts`:

| Interface | Methods | Implementations |
|---|---|---|
| `LeadSourceAdapter` | `searchBusinesses`, `getBusinessDetails`, `findWebsite`, `findPublicContacts`, `isConfigured`, `configurationHint`, `dataPolicy`, `rateLimitPerSec`, `queryMode` | Google Places, Foursquare, Yelp, OpenStreetMap, web discovery, CSV/JSON import |
| `WebSearchProvider` | `search(query, opts)` | Brave Search, Google Programmable Search |
| `GeoProvider` | `geocode`, `subdivisions` | OpenStreetMap (Nominatim + Overpass) |
| `AiProvider` | `generateJson(request)` with a zod schema, optional images | Anthropic Claude, disabled stub |

`src/providers/registry.ts` builds the active set from configuration. **Every provider is
optional.** A missing key means the provider is not queried, and Settings → Sources shows why and
how to set it up. Providers can also be switched off in Settings without removing the key.

## Every call goes through one path

`callProviderJson` (`src/providers/base.ts`) runs these steps in order:

1. **Circuit breaker** (`providers/health.ts`). After 5 consecutive failures the provider is
   skipped for 2 minutes, doubling each time up to 30 minutes. HTTP 401/403 opens it immediately
   for 16 minutes, with the message "check the API key and API enablement". State is kept per
   process and mirrored to the `Source` table for the UI: total calls, failures, average latency,
   last error, open-until.
2. **Cache.** Responses are stored in `CacheEntry`, keyed by a hash of the request, with a TTL per
   provider (table below). A hit costs nothing and is counted in `ProviderUsage.cacheHits`.
3. **Per-job budget** (`MAX_PROVIDER_CALLS_PER_JOB`). Once it is exhausted the job stops making
   paid calls and says so in its log.
4. **Token bucket** rate limiter per provider.
5. **Resilient HTTP** (`lib/http.ts`): timeout, retries with exponential backoff and full jitter
   on 408/425/429/5xx and network errors, `Retry-After` honoured, cancellation, response size cap,
   charset decoding. Logs contain provider, request (URL with secret query parameters redacted),
   status, latency and attempt, but never keys.
6. **Health and usage accounting**: calls per provider per day in `ProviderUsage`.

In a search job the source orchestrator fans queries out to all active sources with a global
concurrency limit (4) and a per-provider limit (2). If one provider fails, only that provider's
results are affected: its status becomes `partial`, `failed` or `circuit_open` and is shown on the
job page. This is tested (`tests/integration/pipeline.test.ts`, "keeps working when Google Places
fails").

## Sources

| Provider | Key | Search | Website | Contacts | Rate limit | Cache TTL | Raw-content retention |
|---|---|---|---|---|---|---|---|
| Google Places (New) | `GOOGLE_PLACES_API_KEY` | text search, up to 3 pages | yes (`websiteUri`) | phone | 5/s | 12 h | 30 days |
| Foursquare Places | `FOURSQUARE_API_KEY` | text search | yes | phone, e-mail, socials | 10/s | 24 h | 30 days |
| Yelp Fusion | `YELP_API_KEY` | text search | **no** (Yelp gives a profile URL only) | phone | 5/s | 12 h | **24 hours** (Yelp terms) |
| OpenStreetMap | none (`OSM_ENABLED`) | Overpass tag query per niche and area | yes (`website`, `contact:website`) | phone, e-mail, socials | 0.5/s | Nominatim 30 d, POIs 3 d | none (ODbL, attribution) |
| Web discovery | Brave or Google CSE key | only when a search API is configured | yes | no | 1/s | 3 days | 30 days |
| CSV/JSON import | – | your rows | if provided | if provided | – | – | none (your data) |

### Google Places API (New)

- Enable **Places API (New)** in a Google Cloud project with billing and create an API key. On a
  server, restrict it by IP address.
- Uses `POST /v1/places:searchText` with an explicit field mask (only the fields we store) and
  `GET /v1/places/{id}` for details.
- Terms: place IDs may be stored indefinitely; other content has limited caching rights. Raw
  content in `SourceRecord` is purged after 30 days by the daily maintenance job (see "Retention"
  below). The official website is the long-term source of truth.

### Foursquare Places

- Supports the new Places API (`places-api.foursquare.com`, versioned by
  `FOURSQUARE_API_VERSION`) and the legacy v3 key format.
- Check your plan's storage terms. Raw content is purged after 30 days.

### Yelp Fusion

- Yelp never returns the business's own website, only its Yelp page. That page is kept as
  `profileUrl` and never treated as an official site. Website discovery then looks elsewhere.
- Terms allow storing business IDs, while other content may be kept for at most 24 hours. Search
  responses are cached for 12 hours and raw records are purged after 24 hours.

### OpenStreetMap (Nominatim + Overpass)

- Free and keyless. Set `OSM_CONTACT_EMAIL`: the Nominatim usage policy asks you to identify
  yourself. We send at most one request every 2 seconds and cache aggressively. For heavy use,
  run your own instance (`NOMINATIM_BASE_URL`, `OVERPASS_BASE_URL`).
- Used as a **geo provider** (city geocoding, district subdivisions for segmented queries) and as
  a **structured source**: one Overpass query per niche and area using the niche's OSM tags from
  `src/domain/taxonomy.ts`. The orchestrator therefore sends it one task per job, not one per
  text query.
- Data is ODbL. Show "© OpenStreetMap contributors" if you publish anything derived from it.

### Web discovery (Brave Search / Google Programmable Search)

- Used to find **official websites** when sources don't list one, and as an extra discovery
  source. Results pass through the same website verification as any other candidate: directory,
  social, booking and map domains are rejected, and the homepage must contain the company's
  name, phone or address. A search-only candidate needs stronger on-page evidence.
- Brave: `BRAVE_SEARCH_API_KEY`. Google: `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`. Google's API
  takes the key as a query parameter; our logs redact it.

### CSV / JSON import

- Leads → Import, or `POST /api/import`. Column names are matched flexibly (`name`,
  `company`, `firma`, `website`, `www`, `phone`, `telefon`, `email`, `address`, `city`,
  `postcode`, `country`, `category`, …).
- Every value is sanitised: control characters are stripped, lengths limited, URLs and e-mails
  validated, and invalid e-mails dropped rather than "fixed". Rows without a name are skipped and
  counted. At most 20,000 rows per import.
- Imported rows go through the same merge, website, analysis and qualification stages as a search.

## AI provider (optional)

- `AI_PROVIDER=auto` uses Anthropic when `ANTHROPIC_API_KEY` is set. `none` never calls AI.
- The model is `AI_MODEL`, default `claude-opus-5`. With `AI_SERVER_FALLBACKS=true`, requests on
  models that support it may fall back to another model on the server side.
- AI is used for only three things, always on top of code-measured facts:
  1. **Visual observations** from screenshots of analysed websites, when both `AI_VISUAL_ANALYSIS`
     and the search's "visual AI" option are on. Analysis itself is already limited to the most
     promising candidates. These are stored as `kind = ai_observation`, labelled as subjective,
     weighted at 60 % and shown separately from measured findings.
  2. **Audit prose**, on request. The AI rewrites and translates the template audit from the same
     facts and may not add new ones.
  3. **Outreach drafts**, on request. The claims linter runs on the result exactly as on template
     drafts.
- Structured output is validated against a zod schema. Refusals and truncated outputs are
  handled explicitly. Responses are cached by prompt hash. Monthly spend is capped by
  `AI_MONTHLY_TOKEN_BUDGET`, and usage is shown in Settings.
- Everything works without AI: technical analysis, scoring, template audits and template outreach
  are deterministic.

## Retention and compliance

`SourceRecord.retentionExpiresAt` is set from each provider's `dataPolicy.retentionHours`. The
daily maintenance job (`node dist/server/cli.js maintenance` runs it on demand) then:

- clears the raw content (name, address, phone, e-mail, website, rating, coordinates, **raw
  payload**) but keeps the provider ID and provenance;
- rebuilds provider-only company attributes (rating, review count, price level, coordinates) from
  records still within retention, or clears them;
- marks contacts that were known **only** from purged listings as expired. Contacts seen on the
  official website are kept.

The company's name, address and phone stay on the merged company record, because the CRM needs
a stable identity. If a provider's terms require you to delete those too, re-verify them against
the official website (Analyze) or remove the lead.

## Adding a new source

1. Create `src/providers/<name>/index.ts` implementing `LeadSourceAdapter`. Normalise results
   into `NormalizedBusiness`. Put an address in `website` **only** if the provider asserts it is
   the business's own site; profile pages belong in `profileUrl`.
2. Route every HTTP call through `callProviderJson` so caching, the budget, rate limiting,
   retries, the circuit breaker and usage accounting apply automatically.
3. Declare `dataPolicy` (retention hours, attribution, notes), `rateLimitPerSec`, `capabilities`
   and `queryMode` (`text` = one call per query, `structured` = one call per niche and area).
4. Register it in `buildProviderRegistry` and add its key to `SECRET_ENV_NAMES` and
   `.env.example`.
5. Add it to the mock provider server in `tests/support/mock-providers.ts` and write a test. The
   pipeline test shows the pattern.

A provider that needs scraping around a CAPTCHA, a login or a paywall must not be added.
