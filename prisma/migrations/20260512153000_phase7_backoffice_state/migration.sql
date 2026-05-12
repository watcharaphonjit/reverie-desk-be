-- Phase 7 back-office persistence: system settings + durable automation state.
CREATE TABLE "system_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "automation_rule_states" (
  "code" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "updatedByUserId" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "lastResult" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_rule_states_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "automation_run_logs" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "triggerSource" TEXT NOT NULL,
  "triggeredByUserId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "success" BOOLEAN,
  "result" JSONB,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_run_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_run_logs_code_startedAt_idx"
ON "automation_run_logs"("code", "startedAt");

CREATE INDEX "automation_run_logs_triggerSource_startedAt_idx"
ON "automation_run_logs"("triggerSource", "startedAt");

CREATE OR REPLACE FUNCTION set_current_timestamp_updatedAt()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER system_settings_set_updatedAt
BEFORE UPDATE ON "system_settings"
FOR EACH ROW
EXECUTE FUNCTION set_current_timestamp_updatedAt();

CREATE TRIGGER automation_rule_states_set_updatedAt
BEFORE UPDATE ON "automation_rule_states"
FOR EACH ROW
EXECUTE FUNCTION set_current_timestamp_updatedAt();

CREATE TRIGGER automation_run_logs_set_updatedAt
BEFORE UPDATE ON "automation_run_logs"
FOR EACH ROW
EXECUTE FUNCTION set_current_timestamp_updatedAt();
