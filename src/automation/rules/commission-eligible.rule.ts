import { Injectable, Logger } from '@nestjs/common';
import { CommissionStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Notify recipients of commissions that have entered ELIGIBLE state but
 * haven't been notified yet. Idempotent: dedupe key includes the
 * commission id so re-runs are no-ops.
 *
 * The transition itself happens in `CommissionsService.evaluateOrderWith`
 * and is triggered by payment / appointment events; this rule is a
 * sweep for any that slipped through.
 */
@Injectable()
export class CommissionEligibleRule implements AutomationRule {
  readonly code = 'COMMISSION_ELIGIBLE';
  readonly description =
    'Hourly — notifies recipients of newly-eligible commissions.';
  readonly schedule = '0 * * * *';

  private readonly logger = new Logger(CommissionEligibleRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const commissions = await this.prisma.commission.findMany({
      where: { status: CommissionStatus.ELIGIBLE },
      select: {
        id: true,
        amount: true,
        recipientUserId: true,
        type: true,
        salesOrder: { select: { id: true, orderNo: true, branchId: true } },
      },
    });

    let created = 0;
    let skipped = 0;
    for (const c of commissions) {
      const result = await this.notifications.notify({
        userId: c.recipientUserId,
        branchId: c.salesOrder.branchId,
        title: `Commission eligible: ${c.amount}`,
        message: `Your ${c.type.replaceAll('_', ' ').toLowerCase()} commission of ${c.amount} on order ${c.salesOrder.orderNo} is eligible.`,
        type: NotificationType.COMMISSION_ELIGIBLE,
        metadata: {
          commissionId: c.id,
          salesOrderId: c.salesOrder.id,
        },
        dedupeKey: `COMMISSION_ELIGIBLE|${c.id}|${c.recipientUserId}`,
      });
      if (result.created) created++;
      else skipped++;
    }

    this.logger.debug(
      `${this.code}: eligible=${commissions.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
