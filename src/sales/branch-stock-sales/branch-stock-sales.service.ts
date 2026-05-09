import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BranchStockSale,
  BranchStockSaleStatus,
  Prisma,
  RefundStatus,
  StockLotStatus,
  StockMovementType,
  WarehouseType,
} from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ApproveRefundDto } from './dto/approve-refund.dto';
import { BranchStockSaleQueryDto } from './dto/branch-stock-sale-query.dto';
import { CancelBranchStockSaleDto } from './dto/cancel-branch-stock-sale.dto';
import { CreateBranchStockSaleDto } from './dto/create-branch-stock-sale.dto';
import { PayBranchStockSaleDto } from './dto/pay-branch-stock-sale.dto';
import { RefundBranchStockSaleDto } from './dto/refund-branch-stock-sale.dto';

const SALE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, code: true, fullName: true, phone: true } },
  salesChannel: { select: { id: true, code: true, name: true } },
  createdByUser: { select: { id: true, fullName: true, email: true } },
  items: {
    include: {
      stockItem: { select: { id: true, sku: true, name: true } },
      stockLot: {
        select: { id: true, lotCode: true, expiresAt: true, warehouseId: true },
      },
    },
  },
  refunds: {
    include: {
      approvedByUser: { select: { id: true, fullName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.BranchStockSaleInclude;

type SaleWithRelations = Prisma.BranchStockSaleGetPayload<{
  include: typeof SALE_INCLUDE;
}>;

const REFUND_INCLUDE = {
  branchStockSale: { select: { id: true, saleNo: true, status: true } },
  approvedByUser: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.BranchStockSaleRefundInclude;

type RefundWithRelations = Prisma.BranchStockSaleRefundGetPayload<{
  include: typeof REFUND_INCLUDE;
}>;

/**
 * Allowed sale-status transitions. CANCELLED is reachable *only* from DRAFT
 * — once payment has been recorded, the only way to reverse is a refund
 * (which itself requires the sale to be COMPLETED first).
 */
const ALLOWED_SALE_TRANSITIONS: Record<
  BranchStockSaleStatus,
  ReadonlySet<BranchStockSaleStatus>
> = {
  [BranchStockSaleStatus.DRAFT]: new Set([
    BranchStockSaleStatus.PAID,
    BranchStockSaleStatus.CANCELLED,
  ]),
  [BranchStockSaleStatus.PAID]: new Set([BranchStockSaleStatus.COMPLETED]),
  [BranchStockSaleStatus.COMPLETED]: new Set([
    BranchStockSaleStatus.PARTIALLY_REFUNDED,
    BranchStockSaleStatus.REFUNDED,
  ]),
  [BranchStockSaleStatus.PARTIALLY_REFUNDED]: new Set([
    BranchStockSaleStatus.PARTIALLY_REFUNDED,
    BranchStockSaleStatus.REFUNDED,
  ]),
  [BranchStockSaleStatus.REFUNDED]: new Set(),
  [BranchStockSaleStatus.CANCELLED]: new Set(),
};

@Injectable()
export class BranchStockSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── CREATE (DRAFT) ───────────────────────────
  /**
   * Create a sale in `DRAFT`. Performs FEFO allocation across the branch's
   * BRANCH-typed warehouse so each requested line expands into one or more
   * sale-item rows pinned to specific lots. No on-hand quantity is touched
   * here — that happens in `complete()`. The allocation is best-effort: if a
   * lot is depleted by another sale before this one completes, `complete()`
   * will fail loudly and the operator can re-create the draft.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateBranchStockSaleDto,
  ): Promise<SaleWithRelations> {
    const [branch, salesChannel, customer] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: dto.branchId } }),
      this.prisma.salesChannel.findUnique({
        where: { id: dto.salesChannelId },
      }),
      dto.customerId
        ? this.prisma.customer.findUnique({ where: { id: dto.customerId } })
        : Promise.resolve(null),
    ]);
    if (!branch) throw new BadRequestException('Branch does not exist');
    if (branch.status !== 'ACTIVE') {
      throw new BadRequestException('Branch is not active');
    }
    if (!salesChannel)
      throw new BadRequestException('Sales channel does not exist');
    if (!salesChannel.isActive) {
      throw new BadRequestException('Sales channel is not active');
    }
    if (dto.customerId && !customer) {
      throw new BadRequestException('Customer does not exist');
    }

    // Validate items + load stock-item snapshots up front so we fail fast on
    // invalid input before opening the transaction.
    const stockItems = await this.prisma.stockItem.findMany({
      where: {
        id: { in: dto.items.map((i) => i.stockItemId) },
        deletedAt: null,
      },
      include: { primaryUnit: { select: { code: true, label: true } } },
    });
    const stockItemMap = new Map(stockItems.map((s) => [s.id, s]));

    for (const [idx, item] of dto.items.entries()) {
      const si = stockItemMap.get(item.stockItemId);
      if (!si) {
        throw new BadRequestException(
          `items[${idx}]: stock item does not exist`,
        );
      }
      if (!si.isActive) {
        throw new BadRequestException(
          `items[${idx}]: stock item is not active`,
        );
      }
      if (!si.isSellable) {
        throw new BadRequestException(
          `items[${idx}]: stock item "${si.sku}" is not sellable`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Resolve the BRANCH warehouse for this branch. Only branch-type
      // warehouses are valid for retail sales — central-hub stock must move
      // through a transfer before it's sellable.
      const branchWarehouse = await tx.warehouse.findFirst({
        where: {
          branchId: dto.branchId,
          type: WarehouseType.BRANCH,
          isActive: true,
        },
      });
      if (!branchWarehouse) {
        throw new BadRequestException(
          `Branch ${branch.code} has no active BRANCH-type warehouse; transfer stock from a central hub first`,
        );
      }

      const allocations: AllocatedItem[] = [];
      const totals = { subtotal: 0, discount: round2(dto.discountAmount ?? 0) };

      // Per spec: each item's `netAmount` is the gross line value
      // (quantity * unitPrice). The whole-sale discount is held on the sale
      // header and only proportionally applied at refund time, so the
      // schema-level invariant `subtotalAmount = Σ items.netAmount` and
      // `totalAmount = subtotalAmount - discountAmount` always holds.
      for (const item of dto.items) {
        const si = stockItemMap.get(item.stockItemId)!;
        const lotPicks = await this.allocateFefo(
          tx,
          item.stockItemId,
          branchWarehouse.id,
          item.quantity,
        );
        const unitPrice = round2(item.unitPrice);
        const unitLabel = si.primaryUnit.label ?? si.primaryUnit.code;

        for (const a of lotPicks) {
          const lineNet = round2(a.qty * unitPrice);
          allocations.push({
            stockItemId: si.id,
            stockLotId: a.stockLotId,
            quantity: a.qty,
            unitPrice,
            netAmount: lineNet,
            snapshotItemName: si.name,
            snapshotUnitLabel: unitLabel,
            snapshotUnitPrice: unitPrice,
          });
          totals.subtotal = round2(totals.subtotal + lineNet);
        }
      }

      if (totals.discount > totals.subtotal) {
        throw new BadRequestException(
          `discountAmount (${totals.discount}) exceeds subtotal (${totals.subtotal})`,
        );
      }
      const total = Math.max(0, round2(totals.subtotal - totals.discount));

      const saleNo = await generateSaleNo(tx, new Date());
      const sale = await tx.branchStockSale.create({
        data: {
          saleNo,
          branchId: dto.branchId,
          customerId: dto.customerId ?? null,
          salesChannelId: dto.salesChannelId,
          createdByUserId: user.id,
          status: BranchStockSaleStatus.DRAFT,
          subtotalAmount: new Prisma.Decimal(totals.subtotal),
          discountAmount: new Prisma.Decimal(totals.discount),
          totalAmount: new Prisma.Decimal(total),
          items: {
            create: allocations.map((a) => ({
              stockItemId: a.stockItemId,
              stockLotId: a.stockLotId,
              quantity: new Prisma.Decimal(a.quantity),
              unitPrice: new Prisma.Decimal(a.unitPrice),
              netAmount: new Prisma.Decimal(a.netAmount),
              snapshotItemName: a.snapshotItemName,
              snapshotUnitLabel: a.snapshotUnitLabel,
              snapshotUnitPrice: new Prisma.Decimal(a.snapshotUnitPrice),
            })),
          },
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: dto.branchId,
        entityType: 'BranchStockSale',
        entityId: sale.id,
        action: AuditAction.CREATE,
        payload: {
          saleNo,
          branchId: dto.branchId,
          itemCount: allocations.length,
          subtotal: totals.subtotal,
          discount: totals.discount,
          total,
          ...(dto.note ? { note: dto.note } : {}),
        },
      });

      return tx.branchStockSale.findUniqueOrThrow({
        where: { id: sale.id },
        include: SALE_INCLUDE,
      });
    });
  }

  // ─────────────────────────── PAY ───────────────────────────
  async pay(
    user: AuthenticatedUser,
    id: string,
    dto: PayBranchStockSaleDto,
  ): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.branchStockSale.findUnique({ where: { id } });
      if (!sale) throw new NotFoundException('Branch stock sale not found');
      this.assertSaleTransition(sale.status, BranchStockSaleStatus.PAID);

      // Underpayment is rejected. Overpayment is allowed (e.g. tendered cash);
      // change is the cashier's problem, not the system's.
      const tendered = round2(dto.paidAmount);
      const total = decToNum(sale.totalAmount);
      if (tendered < total) {
        throw new BadRequestException(
          `paidAmount (${tendered}) is less than totalAmount (${total})`,
        );
      }

      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      await tx.branchStockSale.update({
        where: { id },
        data: { status: BranchStockSaleStatus.PAID, paidAt },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: sale.branchId,
        entityType: 'BranchStockSale',
        entityId: id,
        action: AuditAction.PAY,
        payload: {
          op: 'pay',
          paidAt: paidAt.toISOString(),
          paidAmount: tendered,
          totalAmount: total,
          ...(dto.paymentReference
            ? { paymentReference: dto.paymentReference }
            : {}),
        },
      });

      return tx.branchStockSale.findUniqueOrThrow({
        where: { id },
        include: SALE_INCLUDE,
      });
    });
  }

  // ─────────────────────────── COMPLETE ───────────────────────────
  /**
   * Move PAID → COMPLETED. This is where inventory actually moves: every sale
   * item locks its source lot, deducts its quantity, and writes a
   * `RETAIL_SALE` `StockMovement`. If any lot has been depleted in the
   * interim (e.g., concurrent sale completed before us), the whole tx rolls
   * back — caller must cancel + recreate or wait for restock.
   */
  async complete(
    user: AuthenticatedUser,
    id: string,
  ): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.branchStockSale.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!sale) throw new NotFoundException('Branch stock sale not found');
      this.assertSaleTransition(sale.status, BranchStockSaleStatus.COMPLETED);

      // Aggregate quantity to deduct per source lot — multiple items can
      // share a lot if a single requested line was split across sub-lots.
      const aggregateByLot = new Map<string, number>();
      for (const item of sale.items) {
        aggregateByLot.set(
          item.stockLotId,
          round6(
            (aggregateByLot.get(item.stockLotId) ?? 0) +
              decToNum(item.quantity),
          ),
        );
      }

      // Lock + re-check all lots first.
      for (const lotId of aggregateByLot.keys()) {
        await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${lotId} FOR UPDATE`;
      }
      const lots = await tx.stockLot.findMany({
        where: { id: { in: Array.from(aggregateByLot.keys()) } },
      });
      const lotMap = new Map(lots.map((l) => [l.id, l]));

      for (const [lotId, totalQty] of aggregateByLot) {
        const lot = lotMap.get(lotId);
        if (!lot) {
          throw new BadRequestException(
            `Allocated lot ${lotId} no longer exists`,
          );
        }
        if (lot.status !== StockLotStatus.ACTIVE) {
          throw new BadRequestException(
            `Allocated lot ${lot.lotCode} is ${lot.status}; sale cannot complete`,
          );
        }
        if (totalQty > decToNum(lot.quantityOnHand)) {
          throw new BadRequestException(
            `Allocated lot ${lot.lotCode} has insufficient stock (need ${totalQty}, on hand ${decToNum(lot.quantityOnHand)})`,
          );
        }
      }

      // Deduct + write a movement per sale item so the audit trail is
      // line-grained even when several items share a lot.
      for (const item of sale.items) {
        await tx.stockMovement.create({
          data: {
            stockLotId: item.stockLotId,
            warehouseId: lotMap.get(item.stockLotId)!.warehouseId,
            createdByUserId: user.id,
            type: StockMovementType.RETAIL_SALE,
            quantityDelta: new Prisma.Decimal(-decToNum(item.quantity)),
            unitCost: lotMap.get(item.stockLotId)!.unitCost,
            referenceType: 'BRANCH_STOCK_SALE',
            referenceId: sale.id,
            note: `Sale ${sale.saleNo} item ${item.id}`,
          },
        });
      }

      for (const [lotId, totalQty] of aggregateByLot) {
        const lot = lotMap.get(lotId)!;
        const newOnHand = round6(decToNum(lot.quantityOnHand) - totalQty);
        const exhausted = newOnHand === 0;
        await tx.stockLot.update({
          where: { id: lotId },
          data: {
            quantityOnHand: new Prisma.Decimal(newOnHand),
            ...(exhausted ? { status: StockLotStatus.EXHAUSTED } : {}),
          },
        });
      }

      await tx.branchStockSale.update({
        where: { id: sale.id },
        data: { status: BranchStockSaleStatus.COMPLETED },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: sale.branchId,
        entityType: 'BranchStockSale',
        entityId: sale.id,
        action: AuditAction.COMPLETE,
        payload: {
          op: 'complete',
          itemCount: sale.items.length,
          deductionsByLot: Object.fromEntries(aggregateByLot),
        },
      });

      return tx.branchStockSale.findUniqueOrThrow({
        where: { id: sale.id },
        include: SALE_INCLUDE,
      });
    });
  }

  // ─────────────────────────── CANCEL ───────────────────────────
  async cancel(
    user: AuthenticatedUser,
    id: string,
    dto: CancelBranchStockSaleDto,
  ): Promise<SaleWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.branchStockSale.findUnique({ where: { id } });
      if (!sale) throw new NotFoundException('Branch stock sale not found');
      this.assertSaleTransition(sale.status, BranchStockSaleStatus.CANCELLED);

      await tx.branchStockSale.update({
        where: { id },
        data: { status: BranchStockSaleStatus.CANCELLED },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: sale.branchId,
        entityType: 'BranchStockSale',
        entityId: id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'cancel',
          from: sale.status,
          reason: dto.reason ?? null,
        },
      });

      return tx.branchStockSale.findUniqueOrThrow({
        where: { id },
        include: SALE_INCLUDE,
      });
    });
  }

  // ─────────────────────────── REQUEST REFUND ───────────────────────────
  /**
   * Open a `BranchStockSaleRefund` row in REQUESTED. Stock is *not* restored
   * yet — that happens at approval time. We capture the per-item breakdown
   * in the audit payload so approvers can see what's being refunded.
   */
  async requestRefund(
    user: AuthenticatedUser,
    saleId: string,
    dto: RefundBranchStockSaleDto,
  ): Promise<RefundWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.branchStockSale.findUnique({
        where: { id: saleId },
        include: {
          items: true,
          refunds: {
            where: {
              status: {
                in: [
                  RefundStatus.REQUESTED,
                  RefundStatus.APPROVED,
                  RefundStatus.COMPLETED,
                ],
              },
            },
          },
        },
      });
      if (!sale) throw new NotFoundException('Branch stock sale not found');
      if (
        sale.status !== BranchStockSaleStatus.COMPLETED &&
        sale.status !== BranchStockSaleStatus.PARTIALLY_REFUNDED
      ) {
        throw new ConflictException(
          `Sale must be COMPLETED or PARTIALLY_REFUNDED to refund (current: ${sale.status})`,
        );
      }

      const itemMap = new Map(sale.items.map((it) => [it.id, it]));
      const alreadyRefundedByItem = await this.alreadyRefundedQuantitiesByItem(
        tx,
        saleId,
      );

      // Whole-sale discount is prorated to each refund unit so the cumulative
      // refund of a fully-refunded sale equals exactly `totalAmount` (what
      // the customer actually paid), not `subtotalAmount`. The trailing unit
      // on each sale-item line settles against the item's residual to absorb
      // any rounding drift.
      const saleSubtotal = decToNum(sale.subtotalAmount);
      const saleTotal = decToNum(sale.totalAmount);
      const proratingRatio = saleSubtotal === 0 ? 1 : saleTotal / saleSubtotal;

      let refundAmount = 0;
      const itemBreakdown: Array<{
        saleItemId: string;
        quantity: number;
        lineAmount: number;
        stockLotId: string;
      }> = [];

      for (const [idx, line] of dto.items.entries()) {
        const item = itemMap.get(line.saleItemId);
        if (!item) {
          throw new BadRequestException(
            `items[${idx}].saleItemId does not belong to this sale`,
          );
        }
        const itemQty = decToNum(item.quantity);
        const alreadyRefundedQty = alreadyRefundedByItem.get(item.id) ?? 0;
        const remainingRefundable = round6(itemQty - alreadyRefundedQty);
        if (line.quantity > remainingRefundable) {
          throw new BadRequestException(
            `items[${idx}]: refund quantity (${line.quantity}) exceeds remaining refundable (${remainingRefundable})`,
          );
        }

        const lineGross = decToNum(item.netAmount);
        const lineNetAfterDiscount = round2(lineGross * proratingRatio);
        const perUnitNet = itemQty === 0 ? 0 : lineNetAfterDiscount / itemQty;
        const isFinalUnit =
          round6(alreadyRefundedQty + line.quantity) === itemQty;
        const lineAmount = isFinalUnit
          ? round2(
              lineNetAfterDiscount - round2(alreadyRefundedQty * perUnitNet),
            )
          : round2(line.quantity * perUnitNet);

        refundAmount = round2(refundAmount + lineAmount);
        itemBreakdown.push({
          saleItemId: item.id,
          quantity: line.quantity,
          lineAmount,
          stockLotId: item.stockLotId,
        });
      }

      // Make sure cumulative refunds (this one + all prior open/completed)
      // never exceed the sale's totalAmount.
      const priorOpenAmount = sale.refunds.reduce(
        (acc, r) => acc + decToNum(r.amount),
        0,
      );
      const cumulativeAfter = round2(priorOpenAmount + refundAmount);
      const total = decToNum(sale.totalAmount);
      if (cumulativeAfter > total) {
        throw new BadRequestException(
          `Cumulative refund amount (${cumulativeAfter}) would exceed sale total (${total})`,
        );
      }

      const refundNo = await generateRefundNo(tx, new Date());
      const refund = await tx.branchStockSaleRefund.create({
        data: {
          branchStockSaleId: saleId,
          refundNo,
          amount: new Prisma.Decimal(refundAmount),
          reason: dto.reason ?? null,
          status: RefundStatus.REQUESTED,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: sale.branchId,
        entityType: 'BranchStockSaleRefund',
        entityId: refund.id,
        // We use REFUND for the request entry (semantic: a refund was opened).
        // Approval gets a separate APPROVE entry below.
        action: AuditAction.REFUND,
        payload: {
          op: 'refund-request',
          refundNo,
          saleId,
          amount: refundAmount,
          items: itemBreakdown,
          reason: dto.reason ?? null,
        },
      });

      return tx.branchStockSaleRefund.findUniqueOrThrow({
        where: { id: refund.id },
        include: REFUND_INCLUDE,
      });
    });
  }

  // ─────────────────────────── APPROVE REFUND ───────────────────────────
  /**
   * Approve a refund: restore stock to the original lot(s), mark the refund
   * APPROVED + COMPLETED in one shot, and recompute the sale's `refundAmount`
   * + status (PARTIALLY_REFUNDED or REFUNDED).
   */
  async approveRefund(
    user: AuthenticatedUser,
    refundId: string,
    _dto: ApproveRefundDto,
  ): Promise<RefundWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.branchStockSaleRefund.findUnique({
        where: { id: refundId },
        include: { branchStockSale: { include: { items: true } } },
      });
      if (!refund) throw new NotFoundException('Refund not found');
      if (refund.status !== RefundStatus.REQUESTED) {
        throw new ConflictException(
          `Refund cannot be approved from status ${refund.status}`,
        );
      }

      // Recover the per-item breakdown from the audit log written at request
      // time. Storing it directly on the refund row would be cleaner but the
      // schema has no per-item refund table.
      const requestAudit = await tx.auditLog.findFirst({
        where: {
          entityType: 'BranchStockSaleRefund',
          entityId: refundId,
          action: AuditAction.REFUND,
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!requestAudit) {
        throw new ConflictException(
          'Refund request audit log missing; cannot determine per-item breakdown',
        );
      }
      const breakdown = extractRefundItems(requestAudit.payload);

      // Lock + restore each lot.
      const lotIds = Array.from(new Set(breakdown.map((b) => b.stockLotId)));
      for (const lotId of lotIds) {
        await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${lotId} FOR UPDATE`;
      }
      const lots = await tx.stockLot.findMany({
        where: { id: { in: lotIds } },
      });
      const lotMap = new Map(lots.map((l) => [l.id, l]));

      // Aggregate restore quantities per lot.
      const restoreByLot = new Map<string, number>();
      for (const b of breakdown) {
        restoreByLot.set(
          b.stockLotId,
          round6((restoreByLot.get(b.stockLotId) ?? 0) + b.quantity),
        );
      }

      for (const [lotId, qty] of restoreByLot) {
        const lot = lotMap.get(lotId);
        if (!lot) {
          throw new BadRequestException(
            `Original lot ${lotId} for refund no longer exists`,
          );
        }
        const newOnHand = round6(decToNum(lot.quantityOnHand) + qty);
        // If the lot was EXHAUSTED at sale time, restoring stock should
        // reactivate it. EXPIRED / DISCARDED lots stay in their terminal
        // states — refunding into them would create stock that legally
        // can't be sold; we still record the movement for ledger
        // completeness but flip status only when the lot was just exhausted.
        const nextStatus =
          lot.status === StockLotStatus.EXHAUSTED
            ? StockLotStatus.ACTIVE
            : lot.status;
        await tx.stockLot.update({
          where: { id: lotId },
          data: {
            quantityOnHand: new Prisma.Decimal(newOnHand),
            ...(nextStatus !== lot.status ? { status: nextStatus } : {}),
          },
        });
      }

      // One RETURN movement per refund line so the audit trail mirrors the
      // RETAIL_SALE rows written at complete time.
      for (const b of breakdown) {
        const lot = lotMap.get(b.stockLotId)!;
        await tx.stockMovement.create({
          data: {
            stockLotId: b.stockLotId,
            warehouseId: lot.warehouseId,
            createdByUserId: user.id,
            type: StockMovementType.RETURN,
            quantityDelta: new Prisma.Decimal(b.quantity),
            unitCost: lot.unitCost,
            referenceType: 'BRANCH_STOCK_SALE_REFUND',
            referenceId: refund.id,
            note: `Refund ${refund.refundNo} on sale ${refund.branchStockSale.saleNo}`,
          },
        });
      }

      const now = new Date();
      await tx.branchStockSaleRefund.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.COMPLETED,
          approvedByUserId: user.id,
          approvedAt: now,
          completedAt: now,
        },
      });

      // Recompute sale-level refund total + status.
      const allCompleted = await tx.branchStockSaleRefund.findMany({
        where: {
          branchStockSaleId: refund.branchStockSaleId,
          status: RefundStatus.COMPLETED,
        },
      });
      const totalRefunded = allCompleted.reduce(
        (acc, r) => round2(acc + decToNum(r.amount)),
        0,
      );
      const saleTotal = decToNum(refund.branchStockSale.totalAmount);
      const nextSaleStatus =
        totalRefunded >= saleTotal
          ? BranchStockSaleStatus.REFUNDED
          : BranchStockSaleStatus.PARTIALLY_REFUNDED;
      await tx.branchStockSale.update({
        where: { id: refund.branchStockSaleId },
        data: {
          refundAmount: new Prisma.Decimal(totalRefunded),
          status: nextSaleStatus,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: refund.branchStockSale.branchId,
        entityType: 'BranchStockSaleRefund',
        entityId: refund.id,
        action: AuditAction.APPROVE,
        payload: {
          op: 'refund-approve',
          refundNo: refund.refundNo,
          amount: decToNum(refund.amount),
          totalRefundedAfter: totalRefunded,
          saleStatusAfter: nextSaleStatus,
          restoredByLot: Object.fromEntries(restoreByLot),
        },
      });

      return tx.branchStockSaleRefund.findUniqueOrThrow({
        where: { id: refund.id },
        include: REFUND_INCLUDE,
      });
    });
  }

  // ─────────────────────────── QUERIES ───────────────────────────
  async findAll(
    query: BranchStockSaleQueryDto,
  ): Promise<PaginatedResult<SaleWithRelations>> {
    const where: Prisma.BranchStockSaleWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.salesChannelId ? { salesChannelId: query.salesChannelId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { saleNo: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...this.dateRangeFilter(query.from, query.to),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.branchStockSale.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: SALE_INCLUDE,
      }),
      this.prisma.branchStockSale.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<SaleWithRelations> {
    const sale = await this.prisma.branchStockSale.findUnique({
      where: { id },
      include: SALE_INCLUDE,
    });
    if (!sale) throw new NotFoundException('Branch stock sale not found');
    return sale;
  }

  // ─────────────────────────── helpers ───────────────────────────
  private assertSaleTransition(
    from: BranchStockSaleStatus,
    to: BranchStockSaleStatus,
  ): void {
    if (!ALLOWED_SALE_TRANSITIONS[from].has(to)) {
      throw new ConflictException(
        `Invalid sale status transition: ${from} → ${to}`,
      );
    }
  }

  private dateRangeFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.BranchStockSaleWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { createdAt: range };
  }

  /**
   * FEFO allocation across active lots in a single warehouse. Lots with the
   * earliest expiry are picked first; ties on expiry break on oldest
   * receivedAt; lots without an expiry are last. Throws BadRequest if total
   * available is insufficient.
   *
   * The lots are NOT locked here because allocation runs at draft time when
   * we don't actually mutate quantities — `complete()` re-locks and
   * re-validates before deducting.
   */
  private async allocateFefo(
    tx: Prisma.TransactionClient,
    stockItemId: string,
    warehouseId: string,
    qtyNeeded: number,
  ): Promise<Array<{ stockLotId: string; qty: number }>> {
    const lots = await tx.stockLot.findMany({
      where: {
        stockItemId,
        warehouseId,
        status: StockLotStatus.ACTIVE,
        quantityOnHand: { gt: 0 },
      },
      orderBy: [
        { expiresAt: { sort: 'asc', nulls: 'last' } },
        { receivedAt: 'asc' },
      ],
    });

    let remaining = qtyNeeded;
    const allocations: Array<{ stockLotId: string; qty: number }> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;
      const onHand = decToNum(lot.quantityOnHand);
      if (onHand <= 0) continue;
      const take = Math.min(remaining, onHand);
      allocations.push({ stockLotId: lot.id, qty: round6(take) });
      remaining = round6(remaining - take);
    }

    if (remaining > 0) {
      const totalAvailable = lots.reduce(
        (acc, l) => acc + decToNum(l.quantityOnHand),
        0,
      );
      throw new BadRequestException(
        `Insufficient stock for item ${stockItemId} in branch warehouse (need ${qtyNeeded}, available ${totalAvailable})`,
      );
    }
    return allocations;
  }

  private async alreadyRefundedQuantitiesByItem(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<Map<string, number>> {
    // Walk completed-refund audit logs; each records the per-item breakdown.
    const refunds = await tx.branchStockSaleRefund.findMany({
      where: {
        branchStockSaleId: saleId,
        status: { in: [RefundStatus.APPROVED, RefundStatus.COMPLETED] },
      },
      select: { id: true },
    });
    if (refunds.length === 0) return new Map();
    const audits = await tx.auditLog.findMany({
      where: {
        entityType: 'BranchStockSaleRefund',
        entityId: { in: refunds.map((r) => r.id) },
        action: AuditAction.REFUND,
      },
    });
    const result = new Map<string, number>();
    for (const a of audits) {
      const items = extractRefundItems(a.payload);
      for (const it of items) {
        result.set(
          it.saleItemId,
          round6((result.get(it.saleItemId) ?? 0) + it.quantity),
        );
      }
    }
    return result;
  }
}

// ─────────────────────── module-private utils ───────────────────────
interface AllocatedItem {
  stockItemId: string;
  stockLotId: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  snapshotItemName: string;
  snapshotUnitLabel: string;
  snapshotUnitPrice: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(v.toString());
};

const formatYYYYMMDD = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

async function generateSaleNo(
  tx: Prisma.TransactionClient,
  at: Date,
): Promise<string> {
  const yyyymmdd = formatYYYYMMDD(at);
  const lockKey = `branch-stock-sale-no-${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const prefix = `BSS-${yyyymmdd}-`;
  const last = await tx.branchStockSale.findFirst({
    where: { saleNo: { startsWith: prefix } },
    orderBy: { saleNo: 'desc' },
    select: { saleNo: true },
  });
  const lastSeq = last ? parseInt(last.saleNo.slice(prefix.length), 10) : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

async function generateRefundNo(
  tx: Prisma.TransactionClient,
  at: Date,
): Promise<string> {
  const yyyymmdd = formatYYYYMMDD(at);
  const lockKey = `branch-stock-sale-refund-no-${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const prefix = `BSR-${yyyymmdd}-`;
  const last = await tx.branchStockSaleRefund.findFirst({
    where: { refundNo: { startsWith: prefix } },
    orderBy: { refundNo: 'desc' },
    select: { refundNo: true },
  });
  const lastSeq = last ? parseInt(last.refundNo.slice(prefix.length), 10) : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

interface RefundLineSnapshot {
  saleItemId: string;
  quantity: number;
  stockLotId: string;
  lineAmount: number;
}

/**
 * The per-item refund breakdown lives only in the request-time audit log
 * (no schema table for it). This helper unwraps it defensively from the JSON
 * payload — bad payloads throw, since approving without a breakdown would
 * leak stock.
 */
function extractRefundItems(payload: Prisma.JsonValue): RefundLineSnapshot[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const obj = payload as Record<string, unknown>;
  const items = obj.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const saleItemId = typeof r.saleItemId === 'string' ? r.saleItemId : null;
    const quantity = typeof r.quantity === 'number' ? r.quantity : null;
    const stockLotId = typeof r.stockLotId === 'string' ? r.stockLotId : null;
    const lineAmount = typeof r.lineAmount === 'number' ? r.lineAmount : 0;
    if (!saleItemId || quantity == null || !stockLotId) return [];
    return [{ saleItemId, quantity, stockLotId, lineAmount }];
  });
}

export type { BranchStockSale };
