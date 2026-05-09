import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, StockLotStatus } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationConfigService } from '../automation.config';
import { RecipientsService } from '../recipients.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Lots in ACTIVE status with `expiresAt` falling inside the next
 * `EXPIRY_ALERT_DAYS` window. Notify branch managers + central hub.
 *
 * Dedup: one alert per lot per day. Repeated runs are safe.
 */
@Injectable()
export class ExpiringStockRule implements AutomationRule {
  readonly code = 'EXPIRING_STOCK';
  readonly description = 'Daily — flags lots expiring within the alert window.';
  readonly schedule = '0 8 * * *';

  private readonly logger = new Logger(ExpiringStockRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: AutomationConfigService,
    private readonly recipients: RecipientsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const now = new Date();
    const cutoff = new Date(
      now.getTime() + this.config.expiryAlertDays * 86_400_000,
    );

    const lots = await this.prisma.stockLot.findMany({
      where: {
        status: StockLotStatus.ACTIVE,
        expiresAt: { lte: cutoff, gte: now },
        quantityOnHand: { gt: 0 },
      },
      select: {
        id: true,
        lotCode: true,
        expiresAt: true,
        quantityOnHand: true,
        warehouse: { select: { id: true, code: true, branchId: true } },
        stockItem: { select: { id: true, name: true, sku: true } },
      },
    });

    if (lots.length === 0) {
      return { created: 0, skipped: 0, note: 'no expiring lots' };
    }

    const hub = await this.recipients.centralStockHub();
    const today = now.toISOString().slice(0, 10);
    let created = 0;
    let skipped = 0;

    for (const lot of lots) {
      const recipients = new Set<string>(hub);
      if (lot.warehouse.branchId) {
        const managers = await this.recipients.branchManagers(
          lot.warehouse.branchId,
        );
        managers.forEach((id) => recipients.add(id));
      }
      if (recipients.size === 0) continue;

      const days = lot.expiresAt
        ? Math.ceil((lot.expiresAt.getTime() - now.getTime()) / 86_400_000)
        : null;

      const result = await this.notifications.notifyMany(
        Array.from(recipients),
        {
          title: `Expiring: ${lot.stockItem.name} (${lot.lotCode})`,
          message: `Lot ${lot.lotCode} of ${lot.stockItem.sku} expires in ${days ?? '?'}d at ${lot.warehouse.code}.`,
          type: NotificationType.EXPIRING_STOCK,
          branchId: lot.warehouse.branchId ?? null,
          metadata: {
            stockLotId: lot.id,
            stockItemId: lot.stockItem.id,
            warehouseId: lot.warehouse.id,
            expiresAt: lot.expiresAt?.toISOString() ?? null,
            daysToExpiry: days,
          },
          dedupeKeyPrefix: `EXPIRING_STOCK|${lot.id}|${today}`,
        },
      );
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: lots=${lots.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
