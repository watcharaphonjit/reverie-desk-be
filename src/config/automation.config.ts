import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Tunables for the automation engine. Every threshold flows through Joi
 * validation in env.validation.ts (so a typo is caught at boot), then is
 * read once here and exposed as plain getters so rules don't pay parse
 * cost per run.
 *
 * NOTE: this module previously lived at `src/automation/automation.config.ts`.
 * It has moved here as part of the production-config refactor; the original
 * path re-exports this class to keep existing imports working.
 */
@Injectable()
export class AutomationConfigService {
  readonly lowStockThreshold: number;
  readonly expiryAlertDays: number;
  readonly leadFollowupHours: number;
  readonly appointmentReminderWindowHours: number;
  readonly walletExpiryNoticeDays: number;
  readonly disabledRules: ReadonlySet<string>;

  constructor(config: ConfigService) {
    this.lowStockThreshold = parsePositive(
      config.get('LOW_STOCK_THRESHOLD'),
      5,
    );
    this.expiryAlertDays = parsePositive(
      config.get('EXPIRY_ALERT_DAYS'),
      30,
    );
    this.leadFollowupHours = parsePositive(
      config.get('LEAD_FOLLOWUP_HOURS'),
      48,
    );
    this.appointmentReminderWindowHours = parsePositive(
      config.get('APPOINTMENT_REMINDER_WINDOW_HOURS'),
      24,
    );
    this.walletExpiryNoticeDays = parsePositive(
      config.get('WALLET_EXPIRY_NOTICE_DAYS'),
      7,
    );

    const raw = (config.get<string>('AUTOMATION_DISABLED') ?? '').trim();
    this.disabledRules = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
  }
}

function parsePositive(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
