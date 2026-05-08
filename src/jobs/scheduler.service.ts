import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationService } from '../automation/automation.service';

/**
 * Cron registry. Each handler is a thin pass-through to
 * `AutomationService.runScheduled(code)` which respects per-rule
 * enabled state. The cron expressions match each rule's documented
 * `schedule` so admins reading `GET /automation/rules` know when it
 * fires.
 *
 * Why no dynamic registration: NestJS `@Cron` decorators are evaluated
 * at startup, so adding a new rule means adding a method here. This is
 * intentional — keeping the wiring static makes failure modes obvious
 * (a missing handler is a missing decorator, not a runtime config bug).
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly automation: AutomationService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runDepositPending(): Promise<void> {
    await this.runSafe('DEPOSIT_PENDING');
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async runAppointmentReminder(): Promise<void> {
    await this.runSafe('APPOINTMENT_REMINDER');
  }

  @Cron('0 */2 * * *')
  async runLowStock(): Promise<void> {
    await this.runSafe('LOW_STOCK');
  }

  @Cron('0 8 * * *')
  async runExpiringStock(): Promise<void> {
    await this.runSafe('EXPIRING_STOCK');
  }

  @Cron('*/15 * * * *')
  async runRefundApproval(): Promise<void> {
    await this.runSafe('REFUND_APPROVAL');
  }

  @Cron(CronExpression.EVERY_HOUR)
  async runCommissionEligible(): Promise<void> {
    await this.runSafe('COMMISSION_ELIGIBLE');
  }

  @Cron('0 9 * * *')
  async runWalletExpiry(): Promise<void> {
    await this.runSafe('WALLET_EXPIRY');
  }

  @Cron('0 */4 * * *')
  async runLeadFollowup(): Promise<void> {
    await this.runSafe('LEAD_FOLLOWUP');
  }

  private async runSafe(code: string): Promise<void> {
    try {
      const result = await this.automation.runScheduled(code);
      if (result) {
        this.logger.log(
          `cron ${code}: created=${result.created} skipped=${result.skipped}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `cron ${code} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
