-- CreateTable
CREATE TABLE "branch_quarter_targets" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "totalTarget" DECIMAL(18,2) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_quarter_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_quarter_target_categories" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "commissionGroup" "ServiceGroupCode" NOT NULL,
    "targetAmount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "branch_quarter_target_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_quarter_targets_branchId_year_idx" ON "branch_quarter_targets"("branchId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "branch_quarter_targets_branchId_year_quarter_key" ON "branch_quarter_targets"("branchId", "year", "quarter");

-- CreateIndex
CREATE INDEX "branch_quarter_target_categories_commissionGroup_idx" ON "branch_quarter_target_categories"("commissionGroup");

-- CreateIndex
CREATE UNIQUE INDEX "branch_quarter_target_categories_targetId_commissionGroup_key" ON "branch_quarter_target_categories"("targetId", "commissionGroup");

-- AddForeignKey
ALTER TABLE "branch_quarter_targets" ADD CONSTRAINT "branch_quarter_targets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_quarter_targets" ADD CONSTRAINT "branch_quarter_targets_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_quarter_target_categories" ADD CONSTRAINT "branch_quarter_target_categories_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "branch_quarter_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
