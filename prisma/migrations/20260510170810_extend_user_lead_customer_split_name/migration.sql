/*
  Warnings:

  - You are about to drop the column `birthDate` on the `customers` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomerLevel" AS ENUM ('SILVER', 'GOLD', 'PLATINUM', 'VIP');

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "birthDate",
ADD COLUMN     "address" TEXT,
ADD COLUMN     "allergy" TEXT,
ADD COLUMN     "birthdate" TIMESTAMP(3),
ADD COLUMN     "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "level" "CustomerLevel" NOT NULL DEFAULT 'SILVER',
ADD COLUMN     "lineId" TEXT,
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "convertedCustomerId" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "facebookName" TEXT,
ADD COLUMN     "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "lastName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lineId" TEXT,
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "customers_level_idx" ON "customers"("level");

-- CreateIndex
CREATE INDEX "customers_isActive_idx" ON "customers"("isActive");

-- CreateIndex
CREATE INDEX "leads_convertedCustomerId_idx" ON "leads"("convertedCustomerId");

-- CreateIndex
CREATE INDEX "leads_expiresAt_idx" ON "leads"("expiresAt");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_convertedCustomerId_fkey" FOREIGN KEY ("convertedCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
