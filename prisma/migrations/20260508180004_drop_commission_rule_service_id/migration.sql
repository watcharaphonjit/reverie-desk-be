/*
  Warnings:

  - You are about to drop the column `serviceId` on the `commission_rules` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "commission_rules" DROP CONSTRAINT "commission_rules_serviceId_fkey";

-- DropIndex
DROP INDEX "commission_rules_branchId_serviceId_isActive_idx";

-- AlterTable
ALTER TABLE "commission_rules" DROP COLUMN "serviceId";
