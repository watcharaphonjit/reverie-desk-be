/*
  Warnings:

  - Added the required column `updatedAt` to the `customer_service_events` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ServiceEventStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'VOIDED');

-- AlterTable
ALTER TABLE "customer_service_events" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ServiceEventStatus" NOT NULL DEFAULT 'IN_PROGRESS',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
