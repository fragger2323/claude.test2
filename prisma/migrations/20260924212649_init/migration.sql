-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "studioName" TEXT,
    "senderName" TEXT,
    "senderRole" TEXT,
    "website" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "minProjectSize" INTEGER,
    "targetClientProfile" TEXT,
    "communicationLanguage" TEXT NOT NULL DEFAULT 'en',
    "preferredIndustries" JSONB NOT NULL,
    "excludedIndustries" JSONB NOT NULL,
    "preferredCountries" JSONB NOT NULL,
    "preferredCities" JSONB NOT NULL,
    "preferredTechnologies" JSONB NOT NULL,
    "disallowedProjectTypes" JSONB NOT NULL,
    "portfolioUrls" JSONB NOT NULL,
    "scoringWeights" JSONB,
    "onboardingCompletedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMin" INTEGER,
    "priceMax" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "targetProfile" TEXT,
    "problemTypes" JSONB NOT NULL,
    "minimumFit" INTEGER NOT NULL DEFAULT 40,
    "excludedCases" JSONB NOT NULL,
    "technologies" JSONB NOT NULL,
    "projectSize" TEXT NOT NULL DEFAULT 'medium',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PortfolioProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "industry" TEXT,
    "technologies" JSONB NOT NULL,
    "styles" JSONB NOT NULL,
    "services" JSONB NOT NULL,
    "caseStudy" TEXT,
    "results" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" DATETIME,
    "lastFailureAt" DATETIME,
    "lastError" TEXT,
    "circuitOpenUntil" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SecretSetting" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "serviceSlug" TEXT,
    "targetLeads" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "sourceConfig" JSONB NOT NULL,
    "schedule" TEXT,
    "scheduleHour" INTEGER,
    "campaignId" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavedSearch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT,
    "savedSearchId" TEXT,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "control" TEXT NOT NULL DEFAULT 'run',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "progress" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "sourcesUsed" JSONB NOT NULL,
    "strategyLog" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SearchJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SearchJob_savedSearchId_fkey" FOREIGN KEY ("savedSearchId") REFERENCES "SavedSearch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchQuery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchJobId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "term" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL,
    "segment" TEXT,
    "strategy" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "intent" TEXT NOT NULL DEFAULT 'places',
    "providerIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultsCount" INTEGER NOT NULL DEFAULT 0,
    "newRecordsCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SearchQuery_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueryHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchQueryId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueryHit_searchQueryId_fkey" FOREIGN KEY ("searchQueryId") REFERENCES "SearchQuery" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QueryHit_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" DATETIME,
    "lastError" TEXT,
    "result" JSONB,
    "searchJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "legalName" TEXT,
    "industry" TEXT,
    "categories" JSONB NOT NULL,
    "primaryDomain" TEXT,
    "phoneE164" TEXT,
    "address" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "lat" REAL,
    "lng" REAL,
    "businessStatus" TEXT NOT NULL DEFAULT 'unknown',
    "rating" REAL,
    "ratingCount" INTEGER,
    "priceLevel" INTEGER,
    "sources" JSONB NOT NULL,
    "discrepancies" JSONB NOT NULL,
    "isExistingClient" BOOLEAN NOT NULL DEFAULT false,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" DATETIME,
    "sourceTimestamp" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "label" TEXT,
    "address" TEXT,
    "street" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "region" TEXT,
    "country" TEXT,
    "lat" REAL,
    "lng" REAL,
    "phoneE164" TEXT,
    "sources" JSONB NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Location_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerRecordId" TEXT NOT NULL,
    "searchJobId" TEXT,
    "companyId" TEXT,
    "name" TEXT,
    "normalizedName" TEXT,
    "categories" JSONB NOT NULL,
    "address" TEXT,
    "street" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "region" TEXT,
    "country" TEXT,
    "lat" REAL,
    "lng" REAL,
    "phone" TEXT,
    "phoneE164" TEXT,
    "website" TEXT,
    "websiteDomain" TEXT,
    "email" TEXT,
    "profileUrl" TEXT,
    "businessStatus" TEXT,
    "rating" REAL,
    "ratingCount" INTEGER,
    "priceLevel" INTEGER,
    "payload" JSONB,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retentionExpiresAt" DATETIME,
    "purgedAt" DATETIME,
    CONSTRAINT "SourceRecord_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SourceRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "url" TEXT,
    "domain" TEXT,
    "finalUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'found',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "discoverySource" TEXT,
    "discoveryLog" JSONB NOT NULL,
    "notFoundReason" TEXT,
    "httpStatus" INTEGER,
    "platform" TEXT,
    "lastCheckedAt" DATETIME,
    "lastAnalyzedAt" DATETIME,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Website_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "searchJobId" TEXT,
    "analyzerVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "httpStatus" INTEGER,
    "redirectChain" JSONB NOT NULL,
    "pagesVisited" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "tech" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "contactsFound" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "aiStatus" TEXT NOT NULL DEFAULT 'not_run',
    "aiModel" TEXT,
    "lighthouse" JSONB,
    "fingerprint" TEXT,
    "contentHash" TEXT,
    "diff" JSONB,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "Analysis_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Analysis_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "polarity" TEXT NOT NULL DEFAULT 'negative',
    "severity" TEXT NOT NULL DEFAULT 'low',
    "kind" TEXT NOT NULL DEFAULT 'observed',
    "source" TEXT NOT NULL DEFAULT 'code',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "pageUrl" TEXT,
    "viewport" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'high',
    "problemTags" JSONB NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Finding_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'viewport',
    "path" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Screenshot_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "label" TEXT,
    "personName" TEXT,
    "role" TEXT,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "isRoleBased" BOOLEAN NOT NULL DEFAULT false,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "sightings" JSONB NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiredAt" DATETIME,
    CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "stageChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" TEXT,
    "priorityRank" INTEGER NOT NULL DEFAULT 0,
    "leadFit" INTEGER,
    "websiteNeed" INTEGER,
    "serviceFit" INTEGER,
    "contactability" INTEGER,
    "freshness" INTEGER,
    "components" JSONB,
    "priorityReasons" JSONB NOT NULL,
    "salesPotential" JSONB,
    "decision" JSONB,
    "primaryServiceSlug" TEXT,
    "secondaryServiceSlug" TEXT,
    "mainOpportunity" TEXT,
    "contactAvailability" TEXT,
    "portfolioMatch" JSONB,
    "excludedReason" TEXT,
    "qualifiedAt" DATETIME,
    "lastScoredAt" DATETIME,
    "contactedAt" DATETIME,
    "contactedFeatures" JSONB,
    "nextFollowUpAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "searchJobId" TEXT,
    "excludedReason" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignLead_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignLead_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "serviceId" TEXT,
    "serviceSlug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fitScore" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "exclusionReasons" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recommendation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Recommendation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "analysisId" TEXT,
    "generator" TEXT NOT NULL DEFAULT 'template',
    "aiModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Audit_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Outreach" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "generator" TEXT NOT NULL DEFAULT 'template',
    "aiModel" TEXT,
    "usedFindingIds" JSONB NOT NULL,
    "portfolioProjectId" TEXT,
    "lintWarnings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Outreach_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "note" TEXT,
    "channel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dealValue" INTEGER,
    "serviceSlug" TEXT,
    "notes" TEXT,
    "features" JSONB,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outcome_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "sampleSize" INTEGER NOT NULL,
    "positives" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "coefficients" JSONB NOT NULL,
    "featureSpec" JSONB NOT NULL,
    "notes" TEXT,
    "trainedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_slug_key" ON "Service"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderUsage_provider_day_key" ON "ProviderUsage"("provider", "day");

-- CreateIndex
CREATE INDEX "CacheEntry_namespace_idx" ON "CacheEntry"("namespace");

-- CreateIndex
CREATE INDEX "CacheEntry_expiresAt_idx" ON "CacheEntry"("expiresAt");

-- CreateIndex
CREATE INDEX "SearchJob_createdAt_idx" ON "SearchJob"("createdAt");

-- CreateIndex
CREATE INDEX "SearchQuery_searchJobId_idx" ON "SearchQuery"("searchJobId");

-- CreateIndex
CREATE INDEX "SearchQuery_template_idx" ON "SearchQuery"("template");

-- CreateIndex
CREATE INDEX "QueryHit_sourceRecordId_idx" ON "QueryHit"("sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "QueryHit_searchQueryId_sourceRecordId_provider_key" ON "QueryHit"("searchQueryId", "sourceRecordId", "provider");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Job_searchJobId_idx" ON "Job"("searchJobId");

-- CreateIndex
CREATE INDEX "Company_primaryDomain_idx" ON "Company"("primaryDomain");

-- CreateIndex
CREATE INDEX "Company_phoneE164_idx" ON "Company"("phoneE164");

-- CreateIndex
CREATE INDEX "Company_normalizedName_idx" ON "Company"("normalizedName");

-- CreateIndex
CREATE INDEX "Company_city_idx" ON "Company"("city");

-- CreateIndex
CREATE INDEX "Location_companyId_idx" ON "Location"("companyId");

-- CreateIndex
CREATE INDEX "SourceRecord_companyId_idx" ON "SourceRecord"("companyId");

-- CreateIndex
CREATE INDEX "SourceRecord_searchJobId_idx" ON "SourceRecord"("searchJobId");

-- CreateIndex
CREATE INDEX "SourceRecord_websiteDomain_idx" ON "SourceRecord"("websiteDomain");

-- CreateIndex
CREATE INDEX "SourceRecord_phoneE164_idx" ON "SourceRecord"("phoneE164");

-- CreateIndex
CREATE INDEX "SourceRecord_retentionExpiresAt_idx" ON "SourceRecord"("retentionExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRecord_provider_providerRecordId_key" ON "SourceRecord"("provider", "providerRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Website_companyId_key" ON "Website"("companyId");

-- CreateIndex
CREATE INDEX "Website_domain_idx" ON "Website"("domain");

-- CreateIndex
CREATE INDEX "Analysis_websiteId_startedAt_idx" ON "Analysis"("websiteId", "startedAt");

-- CreateIndex
CREATE INDEX "Analysis_companyId_idx" ON "Analysis"("companyId");

-- CreateIndex
CREATE INDEX "Finding_analysisId_idx" ON "Finding"("analysisId");

-- CreateIndex
CREATE INDEX "Finding_companyId_idx" ON "Finding"("companyId");

-- CreateIndex
CREATE INDEX "Finding_code_idx" ON "Finding"("code");

-- CreateIndex
CREATE INDEX "Screenshot_analysisId_idx" ON "Screenshot"("analysisId");

-- CreateIndex
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_companyId_type_normalizedValue_key" ON "Contact"("companyId", "type", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_companyId_key" ON "Lead"("companyId");

-- CreateIndex
CREATE INDEX "Lead_stage_idx" ON "Lead"("stage");

-- CreateIndex
CREATE INDEX "Lead_priorityRank_idx" ON "Lead"("priorityRank");

-- CreateIndex
CREATE INDEX "Lead_campaignId_idx" ON "Lead"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignLead_searchJobId_idx" ON "CampaignLead"("searchJobId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_campaignId_leadId_key" ON "CampaignLead"("campaignId", "leadId");

-- CreateIndex
CREATE INDEX "Recommendation_leadId_idx" ON "Recommendation"("leadId");

-- CreateIndex
CREATE INDEX "Audit_leadId_idx" ON "Audit"("leadId");

-- CreateIndex
CREATE INDEX "Outreach_leadId_idx" ON "Outreach"("leadId");

-- CreateIndex
CREATE INDEX "Activity_leadId_createdAt_idx" ON "Activity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_leadId_idx" ON "FollowUp"("leadId");

-- CreateIndex
CREATE INDEX "Outcome_leadId_idx" ON "Outcome"("leadId");

-- CreateIndex
CREATE INDEX "Outcome_type_idx" ON "Outcome"("type");

-- CreateIndex
CREATE INDEX "ModelRun_target_active_idx" ON "ModelRun"("target", "active");
