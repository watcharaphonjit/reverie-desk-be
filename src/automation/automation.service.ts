import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AutomationConfigService } from './automation.config';
import { AppointmentReminderRule } from './rules/appointment-reminder.rule';
import {
  AutomationRule,
  AutomationRuleResult,
} from './rules/automation-rule.interface';
import { CommissionEligibleRule } from './rules/commission-eligible.rule';
import { DepositPendingRule } from './rules/deposit-pending.rule';
import { ExpiringStockRule } from './rules/expiring-stock.rule';
import { LeadFollowupRule } from './rules/lead-followup.rule';
import { LowStockRule } from './rules/low-stock.rule';
import { RefundApprovalRule } from './rules/refund-approval.rule';
import { WalletExpiryRule } from './rules/wallet-expiry.rule';

interface RuleEntry {
  rule: AutomationRule;
  enabled: boolean;
  lastRunAt: Date | null;
  lastResult: AutomationRuleResult | null;
}

/**
 * Central registry + dispatcher for automation rules. Rules are
 * registered once at construction (DI gives us all of them) and stored
 * in a Map keyed by their `code`. The scheduler and the admin
 * controller both call into this service.
 *
 * Enable/disable state lives in memory only — restarting the process
 * resets to the env-driven defaults from `AutomationConfigService`. A
 * persistent store can be added later by extending `setEnabled` to
 * upsert into a small `automation_rule_state` table.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);
  private readonly registry = new Map<string, RuleEntry>();

  constructor(
    config: AutomationConfigService,
    deposit: DepositPendingRule,
    appointment: AppointmentReminderRule,
    lowStock: LowStockRule,
    expiringStock: ExpiringStockRule,
    refundApproval: RefundApprovalRule,
    commissionEligible: CommissionEligibleRule,
    walletExpiry: WalletExpiryRule,
    leadFollowup: LeadFollowupRule,
  ) {
    const all: AutomationRule[] = [
      deposit,
      appointment,
      lowStock,
      expiringStock,
      refundApproval,
      commissionEligible,
      walletExpiry,
      leadFollowup,
    ];
    for (const rule of all) {
      this.registry.set(rule.code, {
        rule,
        enabled: !config.disabledRules.has(rule.code),
        lastRunAt: null,
        lastResult: null,
      });
    }
    this.logger.log(
      `Registered ${this.registry.size} automation rules (${[...this.registry.values()].filter((e) => !e.enabled).length} disabled by config)`,
    );
  }

  list(): Array<{
    code: string;
    description: string;
    schedule: string;
    enabled: boolean;
    lastRunAt: string | null;
    lastResult: AutomationRuleResult | null;
  }> {
    return Array.from(this.registry.values()).map((e) => ({
      code: e.rule.code,
      description: e.rule.description,
      schedule: e.rule.schedule,
      enabled: e.enabled,
      lastRunAt: e.lastRunAt?.toISOString() ?? null,
      lastResult: e.lastResult,
    }));
  }

  setEnabled(code: string, enabled: boolean): void {
    const entry = this.registry.get(code);
    if (!entry) throw new NotFoundException(`Unknown rule: ${code}`);
    entry.enabled = enabled;
    this.logger.log(`Rule ${code} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Run a rule by code. Always returns the result, even when the rule
   * is disabled (manual run is a privileged override). The scheduler
   * uses `runScheduled` which respects the enabled flag.
   */
  async run(code: string): Promise<AutomationRuleResult> {
    const entry = this.registry.get(code);
    if (!entry) throw new NotFoundException(`Unknown rule: ${code}`);
    return this.invoke(entry);
  }

  /**
   * Scheduler entry point — silently skips disabled rules so the cron
   * itself doesn't have to know about config.
   */
  async runScheduled(code: string): Promise<AutomationRuleResult | null> {
    const entry = this.registry.get(code);
    if (!entry) return null;
    if (!entry.enabled) {
      this.logger.debug(`skip ${code}: disabled`);
      return null;
    }
    return this.invoke(entry);
  }

  private async invoke(entry: RuleEntry): Promise<AutomationRuleResult> {
    const start = Date.now();
    try {
      const result = await entry.rule.execute();
      entry.lastRunAt = new Date();
      entry.lastResult = result;
      this.logger.log(
        `Rule ${entry.rule.code} done in ${Date.now() - start}ms — created=${result.created} skipped=${result.skipped}`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Rule ${entry.rule.code} threw: ${msg}`);
      entry.lastRunAt = new Date();
      entry.lastResult = { created: 0, skipped: 0, note: `error: ${msg}` };
      throw new BadRequestException(`Rule failed: ${msg}`);
    }
  }
}
