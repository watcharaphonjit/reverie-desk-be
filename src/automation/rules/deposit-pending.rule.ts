import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationType,
  PaymentStatus,
  Prisma,
  SalesOrderStatus,
} from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipientsService } from '../recipients.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

const decToNum = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : Number(v.toString());

/**
 * Sales orders that:
 *   - have a `depositRequired > 0`,
 *   - are still active (CONFIRMED / DRAFT / PARTIALLY_PAID),
 *   - haven't reached `depositSatisfiedAt`,
 *   - currently sum less paid than required.
 *
 * Notify: sales creator + branch managers, once per (order, day).
 */
@Injectable()
export class DepositPendingRule implements AutomationRule {
  readonly code = 'DEPOSIT_PENDING';
  readonly description =
    'Hourly check — flags sales orders with unpaid deposits.';
  readonly schedule = '0 * * * *';

  private readonly logger = new Logger(DepositPendingRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly recipients: RecipientsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const candidates = await this.prisma.salesOrder.findMany({
      where: {
        depositSatisfiedAt: null,
        depositRequired: { gt: 0 },
        status: {
          notIn: [
            SalesOrderStatus.CANCELLED,
            SalesOrderStatus.COMPLETED,
            SalesOrderStatus.REFUNDED,
          ],
        },
      },
      select: {
        id: true,
        orderNo: true,
        branchId: true,
        createdByUserId: true,
        depositRequired: true,
        payments: {
          where: { status: PaymentStatus.SUCCESS },
          select: { amount: true },
        },
      },
    });

    let created = 0;
    let skipped = 0;
    const today = isoDate(new Date());

    for (const order of candidates) {
      const paid = order.payments.reduce(
        (s, p) => s + decToNum(p.amount),
        0,
      );
      const owed = decToNum(order.depositRequired) - paid;
      if (owed <= 0) continue;

      const recipients = new Set<string>();
      if (order.createdByUserId) recipients.add(order.createdByUserId);
      const managers = await this.recipients.branchManagers(order.branchId);
      managers.forEach((id) => recipients.add(id));

      const result = await this.notifications.notifyMany(
        Array.from(recipients),
        {
          title: `Deposit pending — ${order.orderNo}`,
          message: `Order ${order.orderNo} still owes ${owed.toFixed(2)} on its deposit.`,
          type: NotificationType.DEPOSIT_PENDING,
          branchId: order.branchId,
          metadata: {
            salesOrderId: order.id,
            orderNo: order.orderNo,
            owed,
          } as Prisma.InputJsonValue,
          dedupeKeyPrefix: `DEPOSIT_PENDING|${order.id}|${today}`,
        },
      );
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: scanned=${candidates.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
