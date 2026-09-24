# Deployment

Production runs **PostgreSQL** with **two processes from the same build**: the API (which also
serves the SPA) and the worker (jobs, scheduler, browser). Both need the same `DATA_DIR`, because
the worker writes screenshots and the API serves them.

```
Internet ──TLS──► reverse proxy (Caddy/nginx) ──► API :4000 ──┐
                                                               ├──► PostgreSQL
                                       worker (Chromium) ──────┘      (+ shared DATA_DIR volume)
```

## Option A: Docker Compose (recommended)

`Dockerfile` builds on the official Playwright image, so Chromium and its system libraries match
the pinned Playwright version. It builds the SPA and server bundles with the PostgreSQL Prisma
client and runs as the non-root `pwuser`. `docker-compose.yml` defines four services:
`db` (PostgreSQL 16), `migrate` (one-shot `prisma migrate deploy`), `api` and `worker`.

```bash
cp .env.example .env
# edit .env:
#   APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
#   SETUP_TOKEN=$(openssl rand -hex 16)
#   APP_URL=https://leads.yourstudio.com
#   provider keys (optional), OSM_CONTACT_EMAIL, AI settings (optional)
export POSTGRES_PASSWORD=$(openssl rand -hex 16)   # keep it: it is needed for every compose command
docker compose up -d --build
docker compose ps        # api healthy, worker running, migrate exited (0)
```

Then open the app through your reverse proxy and create the owner account with `SETUP_TOKEN`.

The Compose file already:

- overrides `DATABASE_URL`, `HOST`, `PORT` and `DATA_DIR` for the containers (values in `.env`
  for local development are ignored for these);
- binds the API to `127.0.0.1:4000` only, sets `TRUST_PROXY=1` (one reverse proxy on the same
  host) and runs the worker with `RUN_WORKER_IN_PROCESS=false`;
- enables Chromium's sandbox (`BROWSER_SANDBOX=true` with `deploy/seccomp-chromium.json`);
- keeps data in the named volumes `pgdata` and `appdata`.

This stack was built and run as part of the final review: migrations applied, API healthy on
PostgreSQL, worker processing jobs, a CSV import processed end to end, and an audit exported as
PDF by the sandboxed Chromium in the container.

### Reverse proxy (TLS)

Caddy example (`/etc/caddy/Caddyfile`):

```
leads.yourstudio.com {
  reverse_proxy 127.0.0.1:4000
}
```

nginx: `proxy_pass http://127.0.0.1:4000;` with `proxy_set_header Host $host;`,
`X-Forwarded-For $proxy_add_x_forwarded_for;` and `X-Forwarded-Proto $scheme;`. Allow request
bodies up to 8 MB (`client_max_body_size 8m;`) for CSV imports.

Cookies are `Secure` in production, so the app must be served over HTTPS.

## Option B: bare metal / VM (systemd)

```bash
# once
sudo apt install -y postgresql
sudo -u postgres createuser -P aios && sudo -u postgres createdb -O aios aios
git clone … /opt/aios && cd /opt/aios
npm ci
npx playwright install --with-deps chromium
cp .env.example .env    # NODE_ENV=production, DATABASE_URL=postgresql://aios:…@localhost:5432/aios?schema=public,
                        # APP_ENCRYPTION_KEY, SETUP_TOKEN, APP_URL, TRUST_PROXY=1, DATA_DIR=/var/lib/aios
npm run db:pg:generate  # PostgreSQL Prisma client
npm run build
npm run db:pg:deploy    # apply migrations
```

`/etc/systemd/system/aios-api.service`:

```ini
[Unit]
Description=Agency Intelligence OS API
After=network.target postgresql.service

[Service]
User=aios
WorkingDirectory=/opt/aios
EnvironmentFile=/opt/aios/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/aios

[Install]
WantedBy=multi-user.target
```

`aios-worker.service` is the same with `ExecStart=/usr/bin/node dist/server/worker.js`. Set
`BROWSER_SANDBOX=true` when the `aios` user can create user namespaces (the default on current
Ubuntu or Debian unless AppArmor restricts it). Run `node dist/server/worker.js` once by hand to
check that Chromium starts.

### Single process (small setups)

`RUN_WORKER_IN_PROCESS=true` runs the worker inside the API process, so only one service is
needed. This is fine for one user and modest volumes. Keep separate processes if analyses should
not compete with the UI for CPU.

## Scaling notes

- **Workers.** Several worker processes can share one PostgreSQL database. Jobs are claimed with
  a conditional update (a lease), so a job never runs twice. A job whose worker died is re-queued
  when its lease expires. Throughput per worker is `WORKER_CONCURRENCY` jobs and
  `BROWSER_POOL_SIZE` browser contexts.
- **API instances.** The API is stateless apart from the in-memory rate limiter. More than one
  instance needs a shared rate-limit store, and every instance must mount the same `DATA_DIR`
  (or put screenshots on shared storage).
- **SQLite** is for development only: one writer at a time.

## Upgrades

```bash
git pull
docker compose up -d --build          # the migrate service applies new migrations before api/worker start
# bare metal: npm ci && npm run db:pg:generate && npm run build && npm run db:pg:deploy && systemctl restart aios-api aios-worker
```

Schema changes are made in `prisma/schema.prisma`. After `npm run db:pg:schema`, create the
PostgreSQL migration against a development PostgreSQL database with
`npx prisma migrate dev --schema prisma/postgres/schema.prisma --name <change>`, and run
`npm run test:pg` before deploying.

## Backups

- **PostgreSQL:** `docker compose exec db pg_dump -U aios aios | gzip > aios-$(date +%F).sql.gz`
  (or `pg_dump` on bare metal), daily, encrypted, kept off the server.
- **`DATA_DIR`** (screenshots): back up the `appdata` volume or `/var/lib/aios`. It can be
  rebuilt by re-analysing, but the history of old snapshots would be lost.
- **`APP_ENCRYPTION_KEY`:** store it separately (a password manager). Without it the keys entered
  in Settings cannot be decrypted; keys supplied as environment variables are unaffected.

## Health and monitoring

- `GET /api/health` returns database connectivity and queued/running job counts. The Docker
  health check uses it.
- Logs are JSON on stdout. Useful fields: `component` (api/worker/analyzer/provider-health),
  `provider`, `status`, `latencyMs`, `jobId`. Warnings worth alerting on: `circuit opened`,
  `job failed`, `browser disconnected`.
- Settings → Sources shows provider health; Settings → Usage shows calls and AI tokens.
