-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "entitlementConsumedAt" TIMESTAMP(3),
ADD COLUMN     "entitlementId" TEXT;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "defaultSessions" INTEGER,
ADD COLUMN     "isProgram" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "treatment_entitlements" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "consumedSessions" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treatment_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treatment_entitlements_salesOrderItemId_key" ON "treatment_entitlements"("salesOrderItemId");

-- CreateIndex
CREATE INDEX "treatment_entitlements_customerId_idx" ON "treatment_entitlements"("customerId");

-- CreateIndex
CREATE INDEX "treatment_entitlements_serviceId_idx" ON "treatment_entitlements"("serviceId");

-- CreateIndex
CREATE INDEX "treatment_entitlements_customerId_serviceId_expiredAt_idx" ON "treatment_entitlements"("customerId", "serviceId", "expiredAt");

-- CreateIndex
CREATE INDEX "appointments_entitlementId_idx" ON "appointments"("entitlementId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "treatment_entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_entitlements" ADD CONSTRAINT "treatment_entitlements_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_entitlements" ADD CONSTRAINT "treatment_entitlements_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_entitlements" ADD CONSTRAINT "treatment_entitlements_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
