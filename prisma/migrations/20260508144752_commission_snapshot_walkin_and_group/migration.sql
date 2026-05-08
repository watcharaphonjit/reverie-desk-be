-- DropForeignKey
ALTER TABLE "commission_snapshots" DROP CONSTRAINT "commission_snapshots_leadId_fkey";

-- AlterTable
ALTER TABLE "commission_snapshots" ADD COLUMN     "groupSubtotal" DECIMAL(18,2),
ADD COLUMN     "serviceGroupCode" "ServiceGroupCode",
ALTER COLUMN "leadId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "commission_snapshots_salesOrderId_serviceGroupCode_commissi_idx" ON "commission_snapshots"("salesOrderId", "serviceGroupCode", "commissionType");

-- AddForeignKey
ALTER TABLE "commission_snapshots" ADD CONSTRAINT "commission_snapshots_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
