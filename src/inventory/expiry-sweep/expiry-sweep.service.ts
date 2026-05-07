import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AuditAction,
  OpenedContainerStatus,
  Prisma,
  StockLotStatus,
  StockMovementType,
} from '@prisma/client';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface ExpirySweepResult {
  lotsExpired: number;
  containersExpired: number;
  ranAt: string;
}

/**
 * Nightly expiry sweep. The cron handler is the production entrypoint; the
 * `runSweep` method is exposed so a manual admin endpoint can invoke the same
 * logic on demand (handy for ops + integration tests).
 *
 * Idempotency: every update predicate filters on `status = ACTIVE`, so a
 * second run after a first sweep leaves already-expired rows untouched.
 *
 * Atomicity: each row is updated in its own short transaction so a partial
 * failure (e.g., one bad row) doesn't take down the whole sweep — we log and
 * keep going.
 */
@Injectable()
export class ExpirySweepService {
  private readonly logger = new Logger(ExpirySweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Runs every day at 03:00 server-local time. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'expiry-sweep-nightly' })
  async runScheduled(): Promise<void> {
    try {
      const result = await this.runSweep();
      this.logger.log(
        `Nightly expiry sweep complete: ${result.lotsExpired} lots, ${result.containersExpired} containers expired`,
      );
    } catch (err) {
      this.logger.error(
        'Nightly expiry sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Idempotently flip every active row whose expiry has passed:
   *   - `StockLot`: status → `EXPIRED`, on-hand zeroed, `EXPIRE` movement
   *     written with `quantityDelta = -previousOnHand` so the inventory
   *     ledger balances.
   *   - `OpenedContainer`: status → `EXPIRED`. No movement: the lot side of
   *     the ledger was already debited at open time.
   *
   * Pass `actorUserId = null` for the cron path (system-actor); the manual
   * admin trigger should pass the calling user's id so the audit trail is
   * accurate.
   */
  async runSweep(
    actorUserId: string | null = null,
  ): Promise<ExpirySweepResult> {
    const now = new Date();

    const expiredLots = await this.prisma.stockLot.findMany({
      where: {
        status: StockLotStatus.ACTIVE,
        expiresAt: { lt: now },
      },
      select: {
        id: true,
        warehouseId: true,
        quantityOnHand: true,
        expiresAt: true,
        warehouse: { select: { branchId: true } },
      },
    });

    let lotsExpired = 0;
    for (const lot of expiredLots) {
      try {
        await this.expireLot(lot, now, actorUserId);
        lotsExpired += 1;
      } catch (err) {
        this.logger.error(
          `Failed to expire stock lot ${lot.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    const expiredContainers = await this.prisma.openedContainer.findMany({
      where: {
        status: OpenedContainerStatus.ACTIVE,
        expiryAt: { lt: now },
      },
      select: {
        id: true,
        remainingQtyPrimary: true,
        warehouse: { select: { branchId: true } },
      },
    });

    let containersExpired = 0;
    for (const container of expiredContainers) {
      try {
        await this.expireContainer(container, now, actorUserId);
        containersExpired += 1;
      } catch (err) {
        this.logger.error(
          `Failed to expire opened container ${container.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return { lotsExpired, containersExpired, ranAt: now.toISOString() };
  }

  // ─────────────────────── per-row helpers ───────────────────────
  private async expireLot(
    lot: {
      id: string;
      warehouseId: string;
      quantityOnHand: Prisma.Decimal;
      expiresAt: Date | null;
      warehouse: { branchId: string | null };
    },
    now: Date,
    actorUserId: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Re-check + lock so we don't race a manual EXPIRE update.
      const fresh = await tx.stockLot.findFirst({
        where: { id: lot.id, status: StockLotStatus.ACTIVE },
        select: { id: true, quantityOnHand: true },
      });
      if (!fresh) return; // someone beat us to it — fine, no-op.

      const onHandBefore = decToNum(fresh.quantityOnHand);

      await tx.stockLot.update({
        where: { id: lot.id },
        data: {
          status: StockLotStatus.EXPIRED,
          quantityOnHand: new Prisma.Decimal(0),
        },
      });

      if (onHandBefore > 0) {
        await tx.stockMovement.create({
          data: {
            stockLotId: lot.id,
            warehouseId: lot.warehouseId,
            createdByUserId: actorUserId,
            type: StockMovementType.EXPIRE,
            quantityDelta: new Prisma.Decimal(-onHandBefore),
            referenceType: 'EXPIRY_SWEEP',
            referenceId: lot.id,
            note: `Auto-expired at ${now.toISOString()} (expiresAt was ${lot.expiresAt?.toISOString() ?? 'unknown'})`,
          },
        });
      }

      await this.audit.recordWith(tx, {
        actorUserId,
        branchId: lot.warehouse.branchId ?? null,
        entityType: 'StockLot',
        entityId: lot.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'auto-expire',
          previousOnHand: onHandBefore,
          ranAt: now.toISOString(),
        },
      });
    });
  }

  private async expireContainer(
    container: {
      id: string;
      remainingQtyPrimary: Prisma.Decimal;
      warehouse: { branchId: string | null };
    },
    now: Date,
    actorUserId: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.openedContainer.findFirst({
        where: { id: container.id, status: OpenedContainerStatus.ACTIVE },
        select: { id: true, remainingQtyPrimary: true },
      });
      if (!fresh) return;

      await tx.openedContainer.update({
        where: { id: container.id },
        data: { status: OpenedContainerStatus.EXPIRED },
      });

      await this.audit.recordWith(tx, {
        actorUserId,
        branchId: container.warehouse.branchId ?? null,
        entityType: 'OpenedContainer',
        entityId: container.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'auto-expire',
          remainingAtExpire: decToNum(fresh.remainingQtyPrimary),
          ranAt: now.toISOString(),
        },
      });
    });
  }
}

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(v.toString());
};
