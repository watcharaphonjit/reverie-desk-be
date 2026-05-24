-- AlterTable
ALTER TABLE "branches" ADD COLUMN "phone" TEXT,
ADD COLUMN "address" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "orgSalesAmount" DECIMAL(18,2),
ADD COLUMN "adsSalesAmount" DECIMAL(18,2),
ADD COLUMN "procedureTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "depositStatus" TEXT,
ADD COLUMN "appointmentDate" TIMESTAMP(3),
ADD COLUMN "page" TEXT,
ADD COLUMN "adsLink" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "receivingAccount" TEXT;

-- CreateTable
CREATE TABLE "service_default_stock" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "defaultQty" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_default_stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_default_stock_serviceId_idx" ON "service_default_stock"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "service_default_stock_serviceId_stockItemId_key" ON "service_default_stock"("serviceId", "stockItemId");

-- AddForeignKey
ALTER TABLE "service_default_stock" ADD CONSTRAINT "service_default_stock_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_default_stock" ADD CONSTRAINT "service_default_stock_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
