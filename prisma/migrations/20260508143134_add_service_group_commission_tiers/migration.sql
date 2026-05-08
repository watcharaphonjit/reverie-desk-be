-- CreateEnum
CREATE TYPE "ServiceGroupCode" AS ENUM ('RATE_SKIN', 'RATE_HAIR', 'RATE_SURGERY', 'RATE_TRANSPLANT', 'RATE_MEDICINE', 'RATE_SCULPTRA');

-- DropForeignKey
ALTER TABLE "commission_rules" DROP CONSTRAINT "commission_rules_roleId_fkey";

-- AlterTable
ALTER TABLE "commission_rules" ADD COLUMN     "serviceGroupCode" "ServiceGroupCode",
ALTER COLUMN "roleId" DROP NOT NULL,
ALTER COLUMN "startsAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "commissionGroupCode" "ServiceGroupCode";

-- CreateIndex
CREATE INDEX "commission_rules_branchId_serviceGroupCode_isActive_minAmou_idx" ON "commission_rules"("branchId", "serviceGroupCode", "isActive", "minAmount");

-- CreateIndex
CREATE INDEX "services_commissionGroupCode_idx" ON "services"("commissionGroupCode");

-- AddForeignKey
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
