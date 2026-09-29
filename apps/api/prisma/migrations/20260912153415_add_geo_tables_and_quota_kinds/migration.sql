-- AlterTable
ALTER TABLE `QuotaCounter` MODIFY `kind` ENUM('STAFF', 'STORE', 'MEMBER', 'STORAGE_MB', 'TRAFFIC_MB', 'CUSTOM', 'GEO_BRAND', 'GEO_PROMPT', 'GEO_ENGINE', 'GEO_QUERY_MONTHLY', 'GEO_CONTENT_MONTHLY') NOT NULL;

-- CreateTable
CREATE TABLE `GeoBrand` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(255) NULL,
    `aliases` JSON NOT NULL,
    `industry` VARCHAR(191) NULL,
    `locale` VARCHAR(16) NULL,
    `status` ENUM('ACTIVE', 'PAUSED') NOT NULL DEFAULT 'ACTIVE',
    `refreshFreq` ENUM('WEEKLY', 'DAILY') NOT NULL DEFAULT 'WEEKLY',
    `sampleSize` INTEGER NOT NULL DEFAULT 3,
    `engineCodes` JSON NOT NULL,
    `createdBy` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoBrand_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoBrand_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `GeoBrand_tenantId_createdBy_idx`(`tenantId`, `createdBy`),
    UNIQUE INDEX `GeoBrand_tenantId_name_deletedAt_key`(`tenantId`, `name`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoCompetitor` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(255) NULL,
    `aliases` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoCompetitor_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoCompetitor_tenantId_brandId_idx`(`tenantId`, `brandId`),
    UNIQUE INDEX `GeoCompetitor_tenantId_brandId_name_deletedAt_key`(`tenantId`, `brandId`, `name`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoPromptSet` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `source` ENUM('MANUAL', 'AI_GEN', 'IMPORT') NOT NULL DEFAULT 'MANUAL',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoPromptSet_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoPromptSet_tenantId_brandId_idx`(`tenantId`, `brandId`),
    UNIQUE INDEX `GeoPromptSet_tenantId_brandId_name_deletedAt_key`(`tenantId`, `brandId`, `name`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoPrompt` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `promptSetId` VARCHAR(26) NOT NULL,
    `text` TEXT NOT NULL,
    `textHash` VARCHAR(64) NOT NULL,
    `topic` VARCHAR(191) NULL,
    `funnelStage` ENUM('TOFU', 'MOFU', 'BOFU', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `isTracked` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoPrompt_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoPrompt_tenantId_brandId_isTracked_idx`(`tenantId`, `brandId`, `isTracked`),
    INDEX `GeoPrompt_tenantId_promptSetId_idx`(`tenantId`, `promptSetId`),
    UNIQUE INDEX `GeoPrompt_tenantId_brandId_textHash_deletedAt_key`(`tenantId`, `brandId`, `textHash`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoQueryRun` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `triggeredBy` ENUM('SCHEDULE', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `engineCodes` JSON NOT NULL,
    `sampleSize` INTEGER NOT NULL DEFAULT 1,
    `totalQueries` INTEGER NOT NULL DEFAULT 0,
    `doneQueries` INTEGER NOT NULL DEFAULT 0,
    `failedQueries` INTEGER NOT NULL DEFAULT 0,
    `totalCostCents` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `errorSummary` TEXT NULL,
    `createdBy` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoQueryRun_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoQueryRun_tenantId_brandId_createdAt_idx`(`tenantId`, `brandId`, `createdAt`),
    INDEX `GeoQueryRun_tenantId_status_idx`(`tenantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoQueryResult` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `runId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `promptId` VARCHAR(26) NOT NULL,
    `engineCode` VARCHAR(64) NOT NULL,
    `sampleIndex` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'OK', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `rawText` TEXT NULL,
    `rawTruncated` BOOLEAN NOT NULL DEFAULT false,
    `rawTextRef` VARCHAR(191) NULL,
    `preview` VARCHAR(500) NOT NULL DEFAULT '',
    `fingerprint` VARCHAR(64) NOT NULL DEFAULT '',
    `model` VARCHAR(128) NOT NULL DEFAULT '',
    `latencyMs` INTEGER NOT NULL DEFAULT 0,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `searchCalls` INTEGER NOT NULL DEFAULT 0,
    `costCents` INTEGER NOT NULL DEFAULT 0,
    `errorKind` VARCHAR(64) NULL,
    `errorMessage` TEXT NULL,
    `answeredAt` DATETIME(3) NULL,
    `analyzedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoQueryResult_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoQueryResult_tenantId_brandId_answeredAt_idx`(`tenantId`, `brandId`, `answeredAt`),
    INDEX `GeoQueryResult_tenantId_runId_status_idx`(`tenantId`, `runId`, `status`),
    UNIQUE INDEX `GeoQueryResult_tenantId_runId_promptId_engineCode_sampleInde_key`(`tenantId`, `runId`, `promptId`, `engineCode`, `sampleIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoMention` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `resultId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `promptId` VARCHAR(26) NOT NULL,
    `engineCode` VARCHAR(64) NOT NULL,
    `entityKind` ENUM('BRAND', 'COMPETITOR') NOT NULL,
    `competitorId` VARCHAR(26) NULL,
    `entityName` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isCited` BOOLEAN NOT NULL DEFAULT false,
    `sentiment` ENUM('POSITIVE', 'NEUTRAL', 'NEGATIVE') NOT NULL DEFAULT 'NEUTRAL',
    `sentimentScore` INTEGER NOT NULL DEFAULT 0,
    `snippet` VARCHAR(500) NOT NULL DEFAULT '',
    `answeredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoMention_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoMention_tenantId_brandId_answeredAt_idx`(`tenantId`, `brandId`, `answeredAt`),
    INDEX `GeoMention_tenantId_resultId_idx`(`tenantId`, `resultId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoCitation` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `resultId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `promptId` VARCHAR(26) NOT NULL,
    `engineCode` VARCHAR(64) NOT NULL,
    `url` TEXT NOT NULL,
    `urlHash` VARCHAR(64) NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `platform` VARCHAR(64) NOT NULL DEFAULT '',
    `category` ENUM('OWNED', 'COMPETITOR', 'EARNED', 'SOCIAL', 'ENCYCLOPEDIA', 'PR', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `rank` INTEGER NOT NULL DEFAULT 0,
    `title` VARCHAR(191) NULL,
    `answeredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoCitation_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoCitation_tenantId_brandId_answeredAt_idx`(`tenantId`, `brandId`, `answeredAt`),
    INDEX `GeoCitation_tenantId_brandId_domain_idx`(`tenantId`, `brandId`, `domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoVisibilityDaily` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `engineCode` VARCHAR(64) NOT NULL DEFAULT '',
    `promptId` VARCHAR(26) NOT NULL DEFAULT '',
    `date` DATE NOT NULL,
    `answers` INTEGER NOT NULL DEFAULT 0,
    `mentions` INTEGER NOT NULL DEFAULT 0,
    `mentionRateBp` INTEGER NOT NULL DEFAULT 0,
    `sovBp` INTEGER NOT NULL DEFAULT 0,
    `avgPositionX100` INTEGER NOT NULL DEFAULT 0,
    `citationRateBp` INTEGER NOT NULL DEFAULT 0,
    `sentimentAvgX100` INTEGER NOT NULL DEFAULT 0,
    `competitorStats` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoVisibilityDaily_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoVisibilityDaily_tenantId_brandId_date_idx`(`tenantId`, `brandId`, `date`),
    UNIQUE INDEX `GeoVisibilityDaily_tenantId_brandId_engineCode_promptId_date_key`(`tenantId`, `brandId`, `engineCode`, `promptId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoAlertRule` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `kind` ENUM('VISIBILITY_DROP', 'COMPETITOR_OVERTAKE', 'NEGATIVE_MENTION') NOT NULL,
    `thresholdBp` INTEGER NOT NULL DEFAULT 0,
    `channels` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastFiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoAlertRule_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoAlertRule_tenantId_brandId_idx`(`tenantId`, `brandId`),
    UNIQUE INDEX `GeoAlertRule_tenantId_brandId_kind_deletedAt_key`(`tenantId`, `brandId`, `kind`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoAlertEvent` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `ruleId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `kind` ENUM('VISIBILITY_DROP', 'COMPETITOR_OVERTAKE', 'NEGATIVE_MENTION') NOT NULL,
    `payload` JSON NOT NULL,
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoAlertEvent_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoAlertEvent_tenantId_brandId_createdAt_idx`(`tenantId`, `brandId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoReport` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NOT NULL,
    `period` ENUM('WEEKLY', 'MONTHLY') NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoReport_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoReport_tenantId_brandId_periodStart_idx`(`tenantId`, `brandId`, `periodStart`),
    UNIQUE INDEX `GeoReport_tenantId_brandId_period_periodStart_key`(`tenantId`, `brandId`, `period`, `periodStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoUsageLedger` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `brandId` VARCHAR(26) NULL,
    `runId` VARCHAR(26) NULL,
    `metric` ENUM('QUERY', 'LLM_TOKEN', 'CONTENT_GEN') NOT NULL,
    `engineCode` VARCHAR(64) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `costCents` INTEGER NOT NULL DEFAULT 0,
    `month` VARCHAR(7) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoUsageLedger_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GeoUsageLedger_tenantId_month_metric_idx`(`tenantId`, `month`, `metric`),
    INDEX `GeoUsageLedger_tenantId_brandId_occurredAt_idx`(`tenantId`, `brandId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoEngine` (
    `id` VARCHAR(26) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `vendor` VARCHAR(64) NOT NULL,
    `accessType` ENUM('API', 'BROWSER') NOT NULL DEFAULT 'API',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `model` VARCHAR(128) NOT NULL DEFAULT '',
    `baseUrl` VARCHAR(500) NULL,
    `credentialEnc` TEXT NULL,
    `credentialKeyId` VARCHAR(191) NULL,
    `credentialMasked` VARCHAR(191) NULL,
    `pricePerQueryCents` INTEGER NOT NULL DEFAULT 0,
    `priceInPerMTokenCents` INTEGER NOT NULL DEFAULT 0,
    `priceOutPerMTokenCents` INTEGER NOT NULL DEFAULT 0,
    `rateLimitPerMin` INTEGER NOT NULL DEFAULT 60,
    `timeoutMs` INTEGER NOT NULL DEFAULT 60000,
    `config` JSON NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GeoEngine_code_key`(`code`),
    INDEX `GeoEngine_enabled_sort_idx`(`enabled`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoSourcePlatformRule` (
    `id` VARCHAR(26) NOT NULL,
    `pattern` VARCHAR(255) NOT NULL,
    `platform` VARCHAR(64) NOT NULL,
    `category` ENUM('OWNED', 'COMPETITOR', 'EARNED', 'SOCIAL', 'ENCYCLOPEDIA', 'PR', 'OTHER') NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GeoSourcePlatformRule_priority_idx`(`priority`),
    UNIQUE INDEX `GeoSourcePlatformRule_pattern_key`(`pattern`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
