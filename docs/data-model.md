# Data model

Schema: `prisma/schema.prisma` (SQLite, development). The PostgreSQL schema
(`prisma/postgres/schema.prisma`) and its migrations are generated from it by
`npm run db:pg:schema`. Only the datasource provider differs.

**Portability rules.** No native enums (status values are validated string unions in
TypeScript). Structured values are Prisma `Json` columns and have no `@default` (SQLite limitation;
the code always provides them). Business logic uses no raw SQL; the only raw statements are
`SELECT 1` in the health check and SQLite PRAGMAs. The full test suite runs on both databases
(`npm test`, `npm run test:pg`).

```
Campaign ─┬─ SearchJob ─┬─ SearchQuery ─── QueryHit ───┐
          │             └─ Job (queue)                  │
          └─ CampaignLead ─┐                            │
                           │                            ▼
Company ─┬─ SourceRecord (raw provider data + provenance + retention)
         ├─ Location
         ├─ Website ─── Analysis ─┬─ Finding (evidence)
         │                        └─ Screenshot
         ├─ Contact (status + sightings)
         └─ Lead ─┬─ Recommendation   ┬─ Audit     ┬─ Activity
                  ├─ CampaignLead     ├─ Outreach  ├─ FollowUp
                  └─ Outcome (+ feature snapshot)  └─ …
Service · PortfolioProject · BusinessProfile · SavedSearch · ModelRun
Source · ProviderUsage · CacheEntry · SecretSetting · Setting · User · Session
```

## Discovery and provenance

| Table | Purpose | Notable fields |
|---|---|---|
| `Campaign` | a niche × location × service effort | `industry`, `location`, `country`, `serviceSlug`, `targetLeads`, `status` |
| `SearchJob` | one search run (the stage machine) | `params` (validated search params), `status`, `stage`, `control` (`run`/`pause`/`cancel`), `trigger` (`manual`/`scheduled`/`import`), `progress`, `counts`, `sourcesUsed` (per-provider status/calls/records/errors), `strategyLog` |
| `SearchQuery` | each planned query | `text`, `term`, `language`, `segment`, `strategy`, `template` (key for the quality loop), `resultsCount`, `newRecordsCount`, `error` |
| `QueryHit` | which query found which record, and at what rank | unique (`searchQueryId`, `sourceRecordId`, `provider`) |
| `SourceRecord` | one normalised record from one provider | unique (`provider`, `providerRecordId`); `companyId`; name, address, phone, `website` (only if the provider asserts it is official), `profileUrl`, status, rating; `payload` (selected raw attributes); `fetchedAt`, `firstSeenAt`, `lastSeenAt`; `retentionExpiresAt`, `purgedAt` |
| `SavedSearch` | a reusable search, optionally run daily | `params`, `schedule` (`daily`/none), `scheduleHour`, `nextRunAt`, `lastRunAt` |

## Companies and evidence

| Table | Purpose | Notable fields |
|---|---|---|
| `Company` | merged business entity | `name`, `normalizedName`, `industry`, `categories`, `primaryDomain`, `phoneE164`, address, `lat`/`lng`, `businessStatus`, `rating`/`ratingCount`/`priceLevel`, `sources` (provider IDs), `discrepancies` (conflicting values with sources and times), `isExistingClient`, `doNotContact`, `firstSeenAt`, `lastSeenAt`, `lastVerifiedAt`, `sourceTimestamp` |
| `Location` | additional branches of a company | address, coordinates, phone, `sources` |
| `Website` | the official website decision (1:1 with company) | `url`, `domain`, `status` (`found`/`not_found`/`unreachable`), `confidence`, `discoverySource`, `discoveryLog` (every candidate with its verdict and reasons), `notFoundReason`, `platform`, `lastAnalyzedAt` |
| `Analysis` | one live analysis snapshot | `status`, `analyzerVersion`, `redirectChain`, `pagesVisited`, `metrics` (lab performance and in-page measurements), `tech`, `summary`, `contactsFound`, `errors`, `aiStatus`/`aiModel`, `lighthouse` (null unless it really ran), `fingerprint`, `contentHash`, `diff` (vs the previous snapshot) |
| `Finding` | one evidence-backed observation | `code`, `category`, `polarity` (negative/positive/neutral), `severity`, `kind` (`observed`/`measured`/`ai_observation`), `source` (`code`/`ai`/`lighthouse`), `title`, `detail`, `evidence[]`, `pageUrl`, `viewport`, `confidence`, `problemTags` |
| `Screenshot` | image file metadata | `viewport`, `kind` (`viewport`/`fullpage`), `path` (under `DATA_DIR/screenshots/<analysisId>/`), `sha256` |
| `Contact` | public business contact | unique (`companyId`, `type`, `normalizedValue`); `type` (email/phone/contact_form/social), `source`, `sourceUrl`, `status` (verified/probable/unverified), `confidence`, `isRoleBased`, `isPersonal`, `sightings[]` (every observation with source, URL, time, on-official-site), `lastVerifiedAt`, `expiredAt` (set when only purged listings supported it) |

## CRM

| Table | Purpose | Notable fields |
|---|---|---|
| `Lead` | the CRM record (1:1 with company) | `stage` (new, discovered, verified, analyzed, qualified, contact_ready, contacted, replied, meeting, proposal, won, lost, follow_up), `priority`, `priorityRank`, component scores, `components` (full factor lists), `priorityReasons`, `salesPotential` (Mode A/B), `decision` (decision intelligence), primary/secondary service, `mainOpportunity`, `contactAvailability`, `portfolioMatch`, `excludedReason`, `contactedAt`, `contactedFeatures` (frozen snapshot for learning), `nextFollowUpAt`, `notes` |
| `CampaignLead` | lead ↔ campaign/job membership | `excludedReason` (kept, never silently dropped) |
| `Recommendation` | service recommendations | `kind` (primary/secondary/do_not_recommend), `fitScore`, `reasons` (with finding IDs), `exclusionReasons` |
| `Audit` | generated audit | `generator` (template/ai), `content` (structured), `markdown` (editable), `status` |
| `Outreach` | message draft | `channel`, `tone`, `language`, `subject`, `body`, `usedFindingIds`, `portfolioProjectId`, `lintWarnings`, `status` (draft/approved/discarded/sent_manually), `sentAt` |
| `Activity` | timeline | `type` (stage_change, note, call, outreach_sent, followup_scheduled, followup_done, outcome, …), `summary`, `data` |
| `FollowUp` | reminders | `dueAt`, `status` (pending/done/skipped), `channel`, `note` |
| `Outcome` | result of contacting | `type` (replied, meeting, proposal, won, lost, no_reply, not_interested, wrong_fit), `dealValue`, `serviceSlug`, `features` (snapshot) |
| `ModelRun` | each training attempt | `target` (reply/won), `version`, `status` (trained/insufficient_data/failed), `active`, `sampleSize`, `positives`, `metrics` (CV Brier vs baseline, AUC, calibration), `coefficients` (+ bootstrap), `featureSpec`, `notes` |

## Studio configuration

| Table | Purpose |
|---|---|
| `BusinessProfile` | a single row (`id = "default"`): studio and sender, languages, currency, minimum project size, target client profile, preferred/excluded industries, countries, cities, preferred technologies, disallowed project types, portfolio URLs, optional scoring weights, onboarding state |
| `Service` | your service catalogue (see [lead-scoring.md](lead-scoring.md#2-service-matching)) |
| `PortfolioProject` | your real projects: industry, technologies, styles, services, case study, results |

## Operations

| Table | Purpose |
|---|---|
| `Job` | the queue: `type`, `payload`, `priority`, `attempts`/`maxAttempts`, `runAfter` (backoff), `lockedBy`/`lockedUntil` (lease), `lastError`, `result` |
| `Source` | provider enable switch and health: calls, failures, consecutive failures, average latency, last success/failure/error, `circuitOpenUntil` |
| `ProviderUsage` | per provider per day: calls, failures, cache hits, AI input/output tokens |
| `CacheEntry` | provider and AI response cache: `key` (hash), `namespace`, `value`, `expiresAt` |
| `SecretSetting` | API keys entered in the UI: AES-256-GCM `ciphertext` and `last4` only |
| `Setting` | small key/value settings |
| `User`, `Session` | owner account (scrypt hash) and sessions (stored as token **hashes**) |

## Lifecycle rules

- **Nothing is deleted silently.** Excluded leads keep their reason, purged provider records keep
  their ID and provenance, and expired contacts keep their history.
- **Erasure** (lead detail → *Delete data*, `DELETE /api/leads/:id`) removes the company, its
  source records, website, analyses, findings, screenshot rows **and files**, contacts, and the
  lead with its whole CRM history. Use it for data-deletion requests. A later search can
  rediscover the business from public sources; *Do not contact* keeps it suppressed instead.
- **Maintenance** (daily): retention purge, expired cache entries, finished queue rows older than
  30 days, expired sessions.
