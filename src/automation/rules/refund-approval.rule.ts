import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma, RefundStatus } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipientsService } from '../recipients.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Catch-up backstop for refund approval. The primary trigger is the
 * inline hook in `RefundsService.create`; this rule scans for any
 * refund still in `REQUESTED` and re-posts the alert (idempotent via
 * dedupe). Useful if the inline hook missed a notification due to a
 * crash or DB outage at the time.
 */
@Injectable()
export class RefundApprovalRule implements AutomationRule {
  readonly code = 'REFUND_APPROVAL';
  readonly description =
    'Every 15 min — alerts approvers about refunds awaiting action.';
  readonly schedule = '*/15 * * * *';

  private readonly logger = new Logger(RefundApprovalRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly recipients: RecipientsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const refunds = await this.prisma.refund.findMany({
      where: { status: RefundStatus.REQUESTED },
      select: {
        id: true,
        refundNo: true,
        amount: true,
        salesOrder: { select: { id: true, orderNo: true, branchId: true } },
      },
    });

    let created = 0;
    let skipped = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const refund of refunds) {
      const recipients = await this.recipients.branchManagers(
        refund.salesOrder.branchId,
      );
      if (recipients.length === 0) continue;
      const result = await this.notifications.notifyMany(recipients, {
        title: `Refund needs approval: ${refund.refundNo}`,
        message: `Refund ${refund.refundNo} for ${refund.amount} on order ${refund.salesOrder.orderNo} is awaiting approval.`,
        type: NotificationType.REFUND_REQUEST,
        branchId: refund.salesOrder.branchId,
        metadata: {
          refundId: refund.id,
          salesOrderId: refund.salesOrder.id,
        } as Prisma.InputJsonValue,
        dedupeKeyPrefix: `REFUND_REQUEST|${refund.id}|${today}`,
      });
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: pending=${refunds.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
