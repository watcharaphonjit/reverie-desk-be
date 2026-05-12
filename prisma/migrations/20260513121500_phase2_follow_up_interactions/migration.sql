ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'FOLLOW_UP';

CREATE TYPE "LeadInteractionType" AS ENUM (
  'CALL',
  'CHAT',
  'NOTE',
  'MEETING',
  'FOLLOW_UP'
);

CREATE TABLE "lead_interactions" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "type" "LeadInteractionType" NOT NULL,
  "note" TEXT NOT NULL,
  "outcome" TEXT,
  "nextActionAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_interactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_interactions_leadId_createdAt_idx"
ON "lead_interactions"("leadId", "createdAt");

CREATE INDEX "lead_interactions_createdByUserId_createdAt_idx"
ON "lead_interactions"("createdByUserId", "createdAt");

ALTER TABLE "lead_interactions"
ADD CONSTRAINT "lead_interactions_leadId_fkey"
FOREIGN KEY ("leadId") REFERENCES "leads"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_interactions"
ADD CONSTRAINT "lead_interactions_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
