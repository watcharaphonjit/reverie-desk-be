/**
 * Standard contract for automation rules. The registry consumes this
 * shape; the scheduler invokes `execute()` on a cron schedule defined
 * outside the rule (in `SchedulerService`).
 *
 * `execute()` must be:
 *   - idempotent (safe to run repeatedly — use NotificationsService
 *     dedupe keys),
 *   - non-throwing for partial failures (log + continue; the registry
 *     wraps the whole call but a single bad row should not nuke the run),
 *   - report counters so the admin endpoint can surface activity.
 */
export interface AutomationRule {
  /** UPPER_SNAKE identifier — also used to enable/disable in config. */
  readonly code: string;
  /** Human-friendly description shown in `GET /automation/rules`. */
  readonly description: string;
  /** Recommended cron expression, for documentation only (the scheduler
   *  decides when to actually fire). Example: `'0 * * * *'`. */
  readonly schedule: string;
  execute(): Promise<AutomationRuleResult>;
}

export interface AutomationRuleResult {
  /** New notifications created this run. */
  created: number;
  /** Candidates skipped (typically due to dedupe). */
  skipped: number;
  /** Optional human-readable note attached to the response. */
  note?: string;
}
