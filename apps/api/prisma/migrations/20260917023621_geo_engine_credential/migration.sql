-- AlterTable
ALTER TABLE `GeoUsageLedger` ADD COLUMN `selfFunded` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `GeoEngineCredential` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `engineCode` VARCHAR(64) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `credentialEnc` TEXT NOT NULL,
    `credentialKeyId` VARCHAR(64) NOT NULL,
    `credentialMasked` TEXT NULL,
    `createdBy` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeoEngineCredential_tenantId_id_idx`(`tenantId`, `id`),
    UNIQUE INDEX `GeoEngineCredential_tenantId_engineCode_deletedAt_key`(`tenantId`, `engineCode`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
