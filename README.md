# Agency Intelligence OS

An internal business-development system for a web studio. You enter **niche + city + country +
service + quantity** (for example: *dental clinics · Warsaw · Poland · premium website redesign ·
100*). The system finds real businesses from several legal sources, merges duplicates, finds each
company's official website, analyses the site live in a real browser on desktop, tablet and mobile,
and records evidence for every problem it finds. It then scores and prioritises each lead with
visible reasons, writes an audit and a first-contact draft, and tracks the lead through a CRM
until you record an outcome. Those outcomes are what it learns from.

It is **evidence-first**: every conclusion shows its source, timestamp, evidence and confidence.
The UI keeps four kinds of statement apart: what we **know** (source data), what we **observed**
(measured by code), what we **infer** (interpretation or AI) and what we **don't know**.

> **Кратко по-русски.** Система ищет компании по нише и городу через легальные источники (API,
> публичные сайты, ваши импорты), объединяет дубликаты и находит официальный сайт. Затем она
> анализирует сайт в реальном браузере на desktop, tablet и mobile и собирает доказательства
> проблем. Каждый лид получает прозрачный приоритет с причинами, аудит и черновик письма. Отправку
> вы делаете сами, система только фиксирует её в CRM. Быстрый старт: `npm install && npm run setup
> && npm run dev`, затем откройте http://localhost:5173. Подробности: [docs/setup.md](docs/setup.md).

## What it will not do

- It does not bypass CAPTCHAs, logins, paywalls or technical limits. It respects `robots.txt`.
- It does not use scraped or bought databases, collect private data, or guess e-mail addresses
  (no `firstname@company.com`). Contacts are public, and each one is labelled verified,
  probable or unverified.
- It does not send messages. Outreach is always a draft that you send yourself.
- It does not invent numbers. There are no Lighthouse scores unless Lighthouse actually ran, and
  no "chance of sale" percentage until a model trained on **your** outcomes beats the base rate.

## Quick start (local, SQLite)

Requirements: Node.js ≥ 22. Playwright's Chromium is installed with `npx playwright install chromium` (skip if already present).

```bash
npm install
npm run setup     # creates .env with a generated APP_ENCRYPTION_KEY, creates and migrates the DB
npm run dev       # API + worker on :4000, UI on http://localhost:5173
```

Open the UI and create the owner account. Onboarding then walks you through five steps:
sources → API keys → My Business (services, portfolio) → first campaign → first leads.
OpenStreetMap works without any key, so you can run a real search straight away. Google Places,
Foursquare, Yelp, Brave Search, Google Programmable Search and Anthropic (AI) are optional. Add
their keys in `.env` or under **Settings**, where they are stored encrypted.

## A normal morning

1. **Today** lists overdue follow-ups, replies waiting over 24 hours, new high-priority leads
   without a draft, stale proposals and leads that need review. Each item comes from a rule over
   your CRM data and links to the exact leads.
2. **New search** (`g n`, or `Ctrl/⌘ K` and type *"Find 50 dentists in Kraków for website
   redesign"*). The job page shows each stage, the real counts, the sources used, the query
   strategy and any provider errors. You can pause, resume, cancel or retry the job.
3. **Leads** is a dense table with filters, sorting, `j`/`k`/`Enter`/`x` keyboard navigation,
   bulk actions and CSV/JSON export.
4. **Lead detail** shows *Why this lead / Why now / What to offer / What not to claim*, the
   evidence with screenshots, contacts with provenance, history and diffs. It also has the audit
   (HTML/PDF/Markdown), the outreach editor with a claims linter, and one-click CRM actions.
5. **CRM**: stages from *New* to *Won/Lost*, follow-ups, outcomes → **Learning**.

Keyboard shortcuts: `Ctrl/⌘ K` opens the command palette, `?` shows help, `/` jumps to the page
search, and `g` followed by a letter navigates: `t` Today, `n` New search, `l` Leads, `c` CRM,
`p` Campaigns, `v` Saved, `d` Dashboard, `e` Learning, `b` My Business, `i` Import,
`s` Settings.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (with in-process worker) + Vite dev server |
| `npm run build` | SPA → `dist/web`, server/worker/CLI bundles → `dist/server` |
| `npm start` / `npm run start:worker` | production API / worker |
| `npm run check` | lint + typecheck + unit & integration tests + build |
| `npm test` | Vitest: unit + integration (mock providers + local fixture websites, no network) |
| `npm run test:e2e` | Playwright end-to-end: setup → search → lead → audit → outreach → CRM |
| `npm run test:pg` | the Vitest suite on PostgreSQL (`TEST_DATABASE_URL`, database name must contain "test") |
| `npm run db:migrate` | new SQLite migration (development) |
| `npm run db:pg:schema` / `db:pg:generate` / `db:pg:deploy` | PostgreSQL schema / client / migrations |
| `node dist/server/cli.js maintenance\|train\|requalify` | retention purge, model training, re-scoring |

## Documentation

| Document | Contents |
|---|---|
| [docs/setup.md](docs/setup.md) | installation, configuration reference, first run, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | principles, components, pipeline, data flow |
| [docs/providers.md](docs/providers.md) | each data source: what it gives, keys, limits, terms, adding a new one |
| [docs/search-engine.md](docs/search-engine.md) | query strategy, fan-out, deduplication, freshness, website discovery, analysis |
| [docs/lead-scoring.md](docs/lead-scoring.md) | findings, service matching, Lead Fit, priority, chance of sale, learning |
| [docs/data-model.md](docs/data-model.md) | every table and why it exists |
| [docs/cost-control.md](docs/cost-control.md) | caching, budgets, incremental work, AI usage |
| [docs/security.md](docs/security.md) | threat model, controls, residual risks |
| [docs/deployment.md](docs/deployment.md) | Docker Compose, bare-metal, PostgreSQL, backups, upgrades |
| [docs/final-review.md](docs/final-review.md) | what is implemented and tested, limitations, known issues, next steps |

## Stack

TypeScript (strict) · Node 22 · Fastify 5 · Prisma 6 (SQLite for development, PostgreSQL for
production) · a lease-based job queue in the database with a separate worker · Playwright ·
React 19 + Vite + TanStack Query/Table + Tailwind 4 · Vitest + Playwright Test · optional
Anthropic Claude.
