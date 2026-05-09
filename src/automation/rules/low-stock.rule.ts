import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma, StockLotStatus } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationConfigService } from '../automation.config';
import { RecipientsService } from '../recipients.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

const decToNum = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : Number(v.toString());

/**
 * Detects (warehouse, stockItem) pairs whose Σ active `quantityOnHand`
 * is at or below `LOW_STOCK_THRESHOLD`. Notifies branch managers of
 * the warehouse's branch + central stock hub users.
 *
 * Dedup: per (warehouse, stockItem, today) — at most one alert per
 * day per location even if the rule runs every 2 hours.
 */
@Injectable()
export class LowStockRule implements AutomationRule {
  readonly code = 'LOW_STOCK';
  readonly description =
    'Every 2 hours — alerts when stock drops below threshold.';
  readonly schedule = '0 */2 * * *';

  private readonly logger = new Logger(LowStockRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: AutomationConfigService,
    private readonly recipients: RecipientsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const groups = await this.prisma.stockLot.groupBy({
      by: ['warehouseId', 'stockItemId'],
      where: { status: StockLotStatus.ACTIVE },
      _sum: { quantityOnHand: true },
    });
    const lows = groups
      .map((g) => ({
        warehouseId: g.warehouseId,
        stockItemId: g.stockItemId,
        onHand: decToNum(g._sum.quantityOnHand),
      }))
      .filter((g) => g.onHand <= this.config.lowStockThreshold);

    if (lows.length === 0) {
      return { created: 0, skipped: 0, note: 'no low-stock pairs' };
    }

    // Hydrate names + warehouse → branch.
    const [warehouses, items, hubUsers] = await Promise.all([
      this.prisma.warehouse.findMany({
        where: {
          id: { in: Array.from(new Set(lows.map((l) => l.warehouseId))) },
        },
        select: { id: true, name: true, code: true, branchId: true },
      }),
      this.prisma.stockItem.findMany({
        where: {
          id: { in: Array.from(new Set(lows.map((l) => l.stockItemId))) },
        },
        select: {
          id: true,
          name: true,
          sku: true,
          isActive: true,
          deletedAt: true,
        },
      }),
      this.recipients.centralStockHub(),
    ]);
    const wByid = new Map(warehouses.map((w) => [w.id, w]));
    const iByid = new Map(items.map((i) => [i.id, i]));

    const today = new Date().toISOString().slice(0, 10);
    let created = 0;
    let skipped = 0;

    for (const low of lows) {
      const wh = wByid.get(low.warehouseId);
      const item = iByid.get(low.stockItemId);
      if (!wh || !item || !item.isActive || item.deletedAt) continue;

      const recipients = new Set<string>(hubUsers);
      if (wh.branchId) {
        const managers = await this.recipients.branchManagers(wh.branchId);
        managers.forEach((id) => recipients.add(id));
      }
      if (recipients.size === 0) continue;

      const result = await this.notifications.notifyMany(
        Array.from(recipients),
        {
          title: `Low stock: ${item.name}`,
          message: `Warehouse ${wh.code} has ${low.onHand} of ${item.sku} (${item.name}) — at or below threshold (${this.config.lowStockThreshold}).`,
          type: NotificationType.LOW_STOCK,
          branchId: wh.branchId ?? null,
          metadata: {
            warehouseId: wh.id,
            stockItemId: item.id,
            onHand: low.onHand,
            threshold: this.config.lowStockThreshold,
          },
          dedupeKeyPrefix: `LOW_STOCK|${wh.id}|${item.id}|${today}`,
        },
      );
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: lowPairs=${lows.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
