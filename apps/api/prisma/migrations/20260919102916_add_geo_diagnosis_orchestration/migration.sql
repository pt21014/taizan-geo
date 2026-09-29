-- AlterTable
ALTER TABLE `GeoQueryRun` ADD COLUMN `diagnosisPromptSetId` VARCHAR(26) NULL,
    ADD COLUMN `diagnosisReportId` VARCHAR(26) NULL,
    ADD COLUMN `isDiagnosis` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GeoReport` MODIFY `period` ENUM('WEEKLY', 'MONTHLY', 'ONE_SHOT') NOT NULL;
