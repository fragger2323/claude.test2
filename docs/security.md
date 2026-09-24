# Security

Agency Intelligence OS is a single-studio internal tool. It holds API keys, a CRM of business
contacts and your notes, and its worker opens **untrusted websites** in a real browser. Those
three things drive the threat model.

## Controls

### Access

- **One owner account.** The first-run setup creates it. In production this requires
  `SETUP_TOKEN` (compared in constant time), so whoever reaches the URL first cannot claim it.
  Later setup calls return 409.
- **Passwords** are hashed with scrypt, 10–200 characters. Login always runs a hash comparison,
  whether or not the user exists, so response time does not reveal accounts. Failed logins are
  logged with the e-mail masked.
- **Sessions** are 256-bit random tokens. Only their SHA-256 hash is stored. The cookie is
  `aios_session`: `HttpOnly`, `SameSite=Strict`, `Secure` in production or when `APP_URL` is
  https, and it expires after `SESSION_TTL_HOURS`. Changing the password revokes every session.
- **CSRF.** Every state-changing request needs the `x-aios-csrf: 1` header, which a cross-site
  form cannot send and a cross-site script cannot send without CORS (we enable none), plus a
  same-origin `Origin` when one is present. Together with SameSite=Strict this blocks CSRF.
- **Rate limits** per client IP: 600 requests/min globally, and 10/min for login and setup.
  `TRUST_PROXY` (off by default) decides whether `X-Forwarded-For` is believed. Enable it only
  behind a proxy, as a hop count or proxy addresses, or clients can spoof their IP.

### Secrets

- Keys come from environment variables, or from Settings, where they are encrypted with
  **AES-256-GCM** using `APP_ENCRYPTION_KEY`. Production refuses to start without a valid key.
  The API returns only a key's status and last four characters. This is tested: the secret
  string never appears in any response or in the stored row.
- Nothing secret is logged. pino redaction covers secret-bearing fields, and URLs are logged
  with `key`, `token`, `cx`, `signature` and similar query parameters replaced by `[redacted]`.
  Error messages do not carry request URLs.
- Placeholder values (`your-key`, `changeme`, `<…>`) are ignored with a warning. `.env` and
  `.env.*` are git-ignored; only `.env.example` is committed.

### Input and output

- **Validation.** Every route validates its body and query with zod, including enums, lengths
  and numeric ranges, and IDs are format-checked. Body limits are 2 MB, or 8 MB for imports.
  Unknown secret names are rejected.
- **Imports.** Control characters are stripped, lengths limited, URLs, e-mails and phones
  validated, at most 20,000 rows. Invalid values are dropped, never "fixed".
- **XSS.** The UI is React, with no `dangerouslySetInnerHTML` anywhere, and ships a Content
  Security Policy (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, …) plus
  helmet headers (HSTS in production, nosniff, referrer policy). Everything taken from websites
  and providers is treated as text. Exported audit HTML escapes every value and is served with
  `default-src 'none'; img-src data:` (tested with a `<script>` payload inside a finding).
- **CSV/Excel injection.** Exported cells beginning with `= + - @`, tab or CR are prefixed with
  `'` (tested).
- **Path traversal.** Screenshots are served only for a valid analysis ID and a
  `[a-z0-9_-]+.jpg` file name inside `DATA_DIR/screenshots`, and only to signed-in users
  (tested with `../` payloads).
- **Errors.** 5xx responses are generic; details go to the server log only.

### Fetching untrusted websites (SSRF and hostile pages)

Company websites come from third-party data, so any of them could be hostile.

- **HTTP client** (`lib/http.ts` with `ssrfGuard`). Before each request **and each redirect
  hop**, the host is resolved and loopback, private, link-local, CGNAT, multicast, reserved,
  documentation and IPv4-mapped ranges are refused, which also covers cloud metadata at
  169.254.169.254. The connection itself goes through a guarded DNS lookup, so a record that
  changes between the check and the connect is caught. There are caps on redirects, response
  size and time.
- **Browser** (`providers/website/analyzer.ts`). Every request from every page (documents,
  scripts, images, XHR, frames) is intercepted and checked the same way; blocked requests are
  recorded. **WebSockets are refused** (request interception does not cover them; regression
  test `tests/integration/analyzer-sandbox.test.ts`). WebRTC is limited to proxied UDP. Each
  page gets a fresh context (no shared cookies or storage), with downloads and service workers
  disabled.
- **Chromium sandbox** (`BROWSER_SANDBOX`). Playwright launches Chromium *without* its own
  sandbox by default. Turn it on wherever the worker runs as a non-root user with user
  namespaces. The Docker setup does this: `BROWSER_SANDBOX=true` plus Playwright's seccomp
  profile (`deploy/seccomp-chromium.json`), verified in the container as uid 1001. Chromium
  refuses its sandbox when run as root, which is why it stays off by default for local
  development.
- `ALLOW_PRIVATE_NETWORK_TARGETS` exists only for the local fixture-site tests, and production
  refuses to start with it.
- robots.txt is honoured (`RESPECT_ROBOTS_TXT`), request rates are low, and the user agent
  identifies the tool.

### Data protection and acceptable use

- **Only public business data.** No logins, CAPTCHAs, paywalls or other technical limits are
  bypassed, and no bought or leaked databases are used. E-mails are never guessed
  (`firstname@…`), obfuscated addresses are not decoded, and mailboxes are never probed over
  SMTP. MX lookups are DNS-only and can be turned off (`EMAIL_MX_CHECK`).
- Every contact keeps its provenance (source, URL, time) and status. Addresses that look personal
  are flagged so they can be handled carefully under GDPR. Role addresses are preferred.
- **Retention.** Provider content is purged on schedule (Google 30 days, Yelp 24 hours, …; see
  [providers.md](providers.md#retention-and-compliance)).
- **Erasure.** *Delete data* on a lead (`DELETE /api/leads/:id`) removes the company, its source
  records, analyses, screenshot files, contacts and CRM history. *Do not contact* suppresses a
  company without deleting it.
- **No sending.** The system never sends e-mail, form submissions or messages. The scheduler
  runs saved searches and maintenance only. Outreach drafts are linted against guarantees, false
  urgency, invented statistics and loss claims, and the best-channel suggestion reminds you of
  consent rules in EU/UK countries.

## Residual risks and recommendations

| Risk | Status / recommendation |
|---|---|
| DNS rebinding against the **browser**: Chromium resolves hostnames itself after our check | Mitigated by per-request interception, the WebSocket block and the sandbox, but not eliminated. Run the worker where internal services are not reachable: a container network without routes to your LAN or metadata service, or a firewall with egress to the internet only. |
| Chromium zero-day on a hostile site | Enable `BROWSER_SANDBOX`, run as non-root (the Docker image uses `pwuser`), keep the Playwright version current, and isolate the worker from the database network where possible. |
| Single account, no 2FA, no roles | Intended for one studio owner. Put the app behind your VPN or an identity-aware proxy if it is reachable from the internet. |
| Rate limiting is in memory, per process | Fine for one API instance. Several instances need a shared store (e.g. Redis for `@fastify/rate-limit`). |
| Backups contain CRM data and encrypted keys | Encrypt backups. Store `APP_ENCRYPTION_KEY` separately from database backups. |
| SQLite file permissions | Development only. Production uses PostgreSQL with its own credentials; restrict `DATA_DIR` to the service user. |
| Dependency vulnerabilities | Versions are pinned by `package-lock.json`. Run `npm audit` and update Playwright, Fastify and Prisma regularly. |

## Reporting

Security issues found in this codebase should be fixed on a branch and covered by a regression
test. Tests exist for CSRF, auth, secret handling, CSV injection, path traversal, SSRF ranges,
the WebSocket block and HTML escaping.
