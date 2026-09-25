# Setup

## Requirements

- Node.js **22 or newer** and npm.
- Chromium for Playwright: `npx playwright install chromium` (on Linux servers add
  `--with-deps` to install the system libraries). You can point `BROWSER_EXECUTABLE_PATH` at an
  existing Chromium instead.
- Development needs nothing else: SQLite is built in. Production uses PostgreSQL 14+ (tested on 16).

## Install and first run

```bash
npm install
npm run setup   # 1) .env from .env.example with a random APP_ENCRYPTION_KEY
                # 2) ./data directory  3) applies the SQLite migrations  4) generates the Prisma client
npm run dev     # API on http://127.0.0.1:4000 (worker in-process) + UI on http://localhost:5173
```

On first open the UI asks you to create the owner account (e-mail, password of at least 10
characters). In production this step also needs `SETUP_TOKEN` (see below). Onboarding then
covers five steps:

1. **Sources.** OpenStreetMap is on by default and needs no key. Add others if you have them.
2. **API keys.** Put them in `.env`, or enter them under Settings → API keys, where they are
   stored with AES-256-GCM. The UI only ever shows the last four characters.
3. **My Business.** Studio name, sender name, services (16 defaults you can edit), portfolio
   projects, preferred and excluded industries and cities.
4. **First campaign.**
5. **First leads.** Run a search. The job page shows every stage with real counts.

## Configuration reference (`.env`)

Every value is validated at startup (`src/config/env.ts`). Placeholder-looking secrets such as
`your-key-here` are ignored, with a warning in Settings.

### Server

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables strict checks (below) |
| `DATABASE_URL` | `file:../data/dev.db` | SQLite path is relative to `prisma/`; PostgreSQL: `postgresql://user:pw@host:5432/db?schema=public` |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | |
| `APP_URL` | – | Public URL. Used for origin checks and secure cookies. Set it in production. |
| `TRUST_PROXY` | `false` | Behind a reverse proxy: hop count (`1`) or proxy IPs/CIDRs. Leave `false` if clients reach the app directly. |
| `APP_ENCRYPTION_KEY` | – | 64 hex characters. **Required in production.** Encrypts API keys entered in the UI. Back it up: without it those keys cannot be decrypted. |
| `SETUP_TOKEN` | – | Required in production to create the first account |
| `SESSION_TTL_HOURS` | `336` | |
| `DATA_DIR` | `./data` | Screenshots. The API and the worker must share it. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | JSON logs. Secrets are redacted. |

### Worker

| Variable | Default | Notes |
|---|---|---|
| `RUN_WORKER_IN_PROCESS` | `false` | `true`: the API process also runs jobs (simple single-box setup) |
| `WORKER_CONCURRENCY` | `2` | jobs in parallel per worker |
| `WORKER_POLL_MS` | `1000` | |
| `SCHEDULER_ENABLED` | `true` | daily saved searches and daily maintenance. It never sends messages. |

### Website analysis

| Variable | Default | Notes |
|---|---|---|
| `BROWSER_POOL_SIZE` | `2` | concurrent browser contexts (one Chromium process per worker) |
| `ANALYSIS_CONCURRENCY` | `2` | websites analysed in parallel per job |
| `ANALYSIS_MAX_PAGES` | `4` | homepage plus up to N−1 internal pages (contact, services, about, pricing) |
| `ANALYSIS_TIMEOUT_MS` | `45000` | per page load |
| `ANALYSIS_SITE_BUDGET_MS` | `180000` | hard budget for one website (all viewports, pages, link checks); results are marked partial after it. A page that freezes its main thread is abandoned after ~30 s. |
| `REANALYZE_AFTER_DAYS` | `14` | fresher analyses are reused (incremental) |
| `RESPECT_ROBOTS_TXT` | `true` | |
| `EMAIL_MX_CHECK` | `true` | DNS MX lookup for published e-mail domains. Mailboxes are never probed. |
| `LIGHTHOUSE_ENABLED` | `false` | optional. Requires installing `lighthouse` yourself. Scores appear only if it really ran. |
| `BROWSER_SANDBOX` | `false` | Chromium's own sandbox for analysed pages. Turn it on for non-root workers with user namespaces; the Docker setup enables it. See [security.md](security.md). |
| `BROWSER_EXECUTABLE_PATH` | – | custom Chromium |
| `HTTP_USER_AGENT` | identifies the tool | |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false` | **tests only.** Refused in production. |

### Cost control

| Variable | Default | Notes |
|---|---|---|
| `MAX_PROVIDER_CALLS_PER_JOB` | `300` | hard cap on paid API calls per search job |
| `JOB_MAX_LEADS` | `1000` | |
| `AI_MONTHLY_TOKEN_BUDGET` | `3000000` | AI calls stop once reached (0 = no AI spend) |

### Sources and AI (all optional)

`GOOGLE_PLACES_API_KEY`, `FOURSQUARE_API_KEY` (+ `FOURSQUARE_API_VERSION`), `YELP_API_KEY`,
`OSM_ENABLED` (+ `OSM_CONTACT_EMAIL`, recommended by the Nominatim usage policy),
`BRAVE_SEARCH_API_KEY`, `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`, `AI_PROVIDER`
(`auto`|`anthropic`|`none`), `ANTHROPIC_API_KEY`, `AI_MODEL` (default `claude-opus-5`),
`AI_EFFORT`, `AI_VISUAL_ANALYSIS`, `AI_SERVER_FALLBACKS`. Base URLs (`*_BASE_URL`) exist for
proxies and tests. See [providers.md](providers.md).

### Production checks

With `NODE_ENV=production` the server refuses to start if `APP_ENCRYPTION_KEY` is missing or
malformed, or if `ALLOW_PRIVATE_NETWORK_TARGETS=true`. It warns when `APP_URL` is missing or
`TRUST_PROXY=true`. Creating the first account requires `SETUP_TOKEN`.

## Running the tests

```bash
npm test               # unit + integration (SQLite; starts local fixture websites and a mock provider API)
npm run test:e2e       # builds the SPA and runs the full UI flow in Chromium
TEST_DATABASE_URL=postgresql://aios:pw@localhost:5432/aios_test npm run test:pg   # same suite on PostgreSQL
npm run check          # lint + typecheck + tests + build
```

No network access or API keys are needed. The integration tests serve three fixture websites
(`tests/fixtures/sites`) on loopback addresses and mock Google Places, Nominatim, Overpass and
Brave (`tests/support/mock-providers.ts`). `npx tsx tests/support/e2e-server.ts` starts the same
environment with the UI for manual exploration.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Search stays "queued" | No worker is running. The job page says so. Start `npm run start:worker`, or set `RUN_WORKER_IN_PROCESS=true` (`npm run dev` does this). |
| Many leads show "Website not verified" | No source listed a website and web search is not configured. Add the site on the lead (*Add website*), or configure Brave/Google search. |
| Leads show "blocked" analysis | The site shows bot protection to automated visitors; it is not bypassed. Check it yourself. |
| Search finds 0 companies | No source is configured or enabled (Settings → Sources), or every provider failed. The job page shows provider status and errors; the strategy log explains the queries. |
| "Website not analysed" on many leads | Cost control: only the most promising ~1.5 × requested quantity are analysed. Use **Analyze** on the lead. |
| Analysis fails with a browser error | Chromium is not installed: `npx playwright install --with-deps chromium`. |
| `SQLITE_BUSY` | Should not happen (WAL + busy timeout + one connection per process). Make sure only one worker writes to the same SQLite file, or use PostgreSQL. |
| Keys entered in Settings stopped working | `APP_ENCRYPTION_KEY` changed. Re-enter the keys or restore the old key. |
| Google Places returns 403 | "Places API (New)" is not enabled for the key, or the key restrictions block the server IP. |
| Nominatim/Overpass 429 | The public OSM servers are rate-limited (we send at most 1 request per 2 s). Set `OSM_CONTACT_EMAIL`, or point `NOMINATIM_BASE_URL`/`OVERPASS_BASE_URL` at your own instance. |
