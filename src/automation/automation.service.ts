import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationConfigService } from './automation.config';
import { AutomationRunsQueryDto } from './dto/automation-runs-query.dto';
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
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.automationRuleState.findMany();
    for (const row of rows) {
      const entry = this.registry.get(row.code);
      if (!entry) continue;
      entry.enabled = row.enabled;
      entry.lastRunAt = row.lastRunAt;
      entry.lastResult = this.coerceResult(row.lastResult);
    }
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

  async setEnabled(
    actor: AuthenticatedUser,
    code: string,
    enabled: boolean,
  ): Promise<void> {
    const entry = this.registry.get(code);
    if (!entry) throw new NotFoundException(`Unknown rule: ${code}`);
    entry.enabled = enabled;
    await this.prisma.$transaction(async (tx) => {
      await tx.automationRuleState.upsert({
        where: { code },
        create: {
          code,
          enabled,
          updatedByUserId: actor.id,
          lastRunAt: entry.lastRunAt,
          lastResult: entry.lastResult
            ? this.toJson(entry.lastResult)
            : Prisma.JsonNull,
        },
        update: {
          enabled,
          updatedByUserId: actor.id,
          lastRunAt: entry.lastRunAt,
          lastResult: entry.lastResult
            ? this.toJson(entry.lastResult)
            : Prisma.JsonNull,
        },
      });
      await this.audit.recordWith(tx, {
        actorUserId: actor.id,
        branchId: actor.branchId,
        entityType: 'AutomationRule',
        entityId: code,
        action: AuditAction.UPDATE,
        payload: {
          field: 'enabled',
          to: enabled,
        },
      });
    });
    this.logger.log(`Rule ${code} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Run a rule by code. Always returns the result, even when the rule
   * is disabled (manual run is a privileged override). The scheduler
   * uses `runScheduled` which respects the enabled flag.
   */
  async run(
    code: string,
    actor?: AuthenticatedUser,
  ): Promise<AutomationRuleResult> {
    const entry = this.registry.get(code);
    if (!entry) throw new NotFoundException(`Unknown rule: ${code}`);
    return this.invoke(entry, {
      triggerSource: 'MANUAL',
      triggeredByUserId: actor?.id ?? null,
      actor,
    });
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
    return this.invoke(entry, {
      triggerSource: 'SCHEDULED',
      triggeredByUserId: null,
    });
  }

  async listRuns(query: AutomationRunsQueryDto) {
    return this.prisma.automationRunLog.findMany({
      where: {
        ...(query.code ? { code: query.code.toUpperCase() } : {}),
        ...(query.success !== undefined ? { success: query.success } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: query.limit ?? 20,
    });
  }

  private async invoke(
    entry: RuleEntry,
    context: {
      triggerSource: 'MANUAL' | 'SCHEDULED';
      triggeredByUserId: string | null;
      actor?: AuthenticatedUser;
    },
  ): Promise<AutomationRuleResult> {
    const start = Date.now();
    const startedAt = new Date();
    const runLog = await this.prisma.automationRunLog.create({
      data: {
        code: entry.rule.code,
        triggerSource: context.triggerSource,
        triggeredByUserId: context.triggeredByUserId,
        startedAt,
      },
    });
    try {
      const result = await entry.rule.execute();
      const finishedAt = new Date();
      entry.lastRunAt = finishedAt;
      entry.lastResult = result;
      await this.persistRuntimeState(
        entry,
        context.triggeredByUserId,
        runLog.id,
        {
          finishedAt,
          success: true,
          result,
          note: result.note ?? null,
        },
      );
      if (context.actor) {
        await this.audit.record({
          actorUserId: context.actor.id,
          branchId: context.actor.branchId,
          entityType: 'AutomationRule',
          entityId: entry.rule.code,
          action: AuditAction.UPDATE,
          payload: {
            op: 'manual-run',
            result: this.toJson(result),
          },
        });
      }
      this.logger.log(
        `Rule ${entry.rule.code} done in ${Date.now() - start}ms — created=${result.created} skipped=${result.skipped}`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Rule ${entry.rule.code} threw: ${msg}`);
      const finishedAt = new Date();
      entry.lastRunAt = finishedAt;
      entry.lastResult = { created: 0, skipped: 0, note: `error: ${msg}` };
      await this.persistRuntimeState(
        entry,
        context.triggeredByUserId,
        runLog.id,
        {
          finishedAt,
          success: false,
          result: entry.lastResult,
          note: msg,
        },
      );
      throw new BadRequestException(`Rule failed: ${msg}`);
    }
  }

  private async persistRuntimeState(
    entry: RuleEntry,
    updatedByUserId: string | null,
    runLogId: string,
    params: {
      finishedAt: Date;
      success: boolean;
      result: AutomationRuleResult;
      note: string | null;
    },
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.automationRuleState.upsert({
        where: { code: entry.rule.code },
        create: {
          code: entry.rule.code,
          enabled: entry.enabled,
          updatedByUserId,
          lastRunAt: entry.lastRunAt,
          lastResult: this.toJson(params.result),
        },
        update: {
          enabled: entry.enabled,
          updatedByUserId,
          lastRunAt: entry.lastRunAt,
          lastResult: this.toJson(params.result),
        },
      }),
      this.prisma.automationRunLog.update({
        where: { id: runLogId },
        data: {
          finishedAt: params.finishedAt,
          success: params.success,
          result: this.toJson(params.result),
          note: params.note,
        },
      }),
    ]);
  }

  private coerceResult(value: unknown): AutomationRuleResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.created !== 'number' ||
      typeof candidate.skipped !== 'number'
    ) {
      return null;
    }
    return {
      created: candidate.created,
      skipped: candidate.skipped,
      note: typeof candidate.note === 'string' ? candidate.note : undefined,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
