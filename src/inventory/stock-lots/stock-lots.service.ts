import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  StockLot,
  StockLotStatus,
  StockMovementType,
} from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdjustStockLotDto,
  StockAdjustmentReason,
} from './dto/adjust-stock-lot.dto';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import {
  ExpiringStockLotQueryDto,
  StockLotQueryDto,
  StockLotSort,
} from './dto/stock-lot-query.dto';

const STOCK_LOT_INCLUDE = {
  stockItem: { select: { id: true, sku: true, name: true, type: true } },
  warehouse: { select: { id: true, code: true, name: true, type: true } },
  supplier: { select: { id: true, code: true, name: true } },
  purchaseReceipt: { select: { id: true, referenceNo: true } },
} satisfies Prisma.StockLotInclude;

type StockLotWithRelations = Prisma.StockLotGetPayload<{
  include: typeof STOCK_LOT_INCLUDE;
}>;

@Injectable()
export class StockLotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async receive(
    user: AuthenticatedUser,
    dto: ReceiveStockDto,
  ): Promise<StockLotWithRelations> {
    if (dto.quantityReceived <= 0) {
      throw new BadRequestException('quantityReceived must be > 0');
    }
    if (dto.unitCost < 0) {
      throw new BadRequestException('unitCost must be >= 0');
    }

    const stockItem = await this.prisma.stockItem.findFirst({
      where: { id: dto.stockItemId, deletedAt: null },
      select: { id: true, isActive: true, name: true },
    });
    if (!stockItem) throw new BadRequestException('Stock item does not exist');
    if (!stockItem.isActive) {
      throw new BadRequestException('Stock item is not active');
    }

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: dto.warehouseId },
      select: { id: true, isActive: true, branchId: true },
    });
    if (!warehouse) throw new BadRequestException('Warehouse does not exist');
    if (!warehouse.isActive) {
      throw new BadRequestException('Warehouse is not active');
    }

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: dto.supplierId },
        select: { id: true },
      });
      if (!supplier) throw new BadRequestException('Supplier does not exist');
    }

    if (dto.purchaseReceiptId) {
      const receipt = await this.prisma.purchaseReceipt.findUnique({
        where: { id: dto.purchaseReceiptId },
        select: { id: true },
      });
      if (!receipt) {
        throw new BadRequestException('Purchase receipt does not exist');
      }
    }

    const lotConflict = await this.prisma.stockLot.findFirst({
      where: { warehouseId: dto.warehouseId, lotCode: dto.lotCode },
      select: { id: true },
    });
    if (lotConflict) {
      throw new ConflictException('lotCode is already used in this warehouse');
    }

    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    const manufacturedAt = dto.manufacturedAt
      ? new Date(dto.manufacturedAt)
      : null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.stockLot.create({
        data: {
          stockItemId: dto.stockItemId,
          warehouseId: dto.warehouseId,
          lotCode: dto.lotCode,
          supplierId: dto.supplierId ?? null,
          purchaseReceiptId: dto.purchaseReceiptId ?? null,
          purchaseReference: dto.purchaseReference ?? null,
          quantityReceived: new Prisma.Decimal(dto.quantityReceived),
          quantityOnHand: new Prisma.Decimal(dto.quantityReceived),
          unitCost: new Prisma.Decimal(dto.unitCost),
          receivedAt,
          manufacturedAt,
          expiresAt,
          status: StockLotStatus.ACTIVE,
        },
        include: STOCK_LOT_INCLUDE,
      });

      // The receiving movement — quantityDelta is positive because we are
      // adding stock. referenceType/Id link back to the source PR if any.
      await tx.stockMovement.create({
        data: {
          stockLotId: lot.id,
          warehouseId: lot.warehouseId,
          createdByUserId: user.id,
          type: StockMovementType.PURCHASE_IN,
          quantityDelta: new Prisma.Decimal(dto.quantityReceived),
          unitCost: new Prisma.Decimal(dto.unitCost),
          referenceType: dto.purchaseReceiptId
            ? 'PURCHASE_RECEIPT'
            : 'STOCK_LOT',
          referenceId: dto.purchaseReceiptId ?? lot.id,
          note: dto.note ?? null,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: warehouse.branchId ?? null,
        entityType: 'StockLot',
        entityId: lot.id,
        action: AuditAction.CREATE,
        payload: {
          lotCode: lot.lotCode,
          warehouseId: lot.warehouseId,
          stockItemId: lot.stockItemId,
          quantityReceived: dto.quantityReceived,
          unitCost: dto.unitCost,
          purchaseReceiptId: dto.purchaseReceiptId ?? null,
          supplierId: dto.supplierId ?? null,
        },
      });

      return lot;
    });
  }

  async findAll(
    query: StockLotQueryDto,
  ): Promise<PaginatedResult<StockLotWithRelations>> {
    const where: Prisma.StockLotWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.expiresAtFilter(query.expiringFrom, query.expiringTo),
      ...(query.search
        ? {
            OR: [
              { lotCode: { contains: query.search, mode: 'insensitive' } },
              {
                purchaseReference: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    // FEFO is the canonical pick order: lots with the earliest expiry come
    // first, lots without an expiry are pushed to the end and broken on
    // oldest-received-first so the longest-shelved stock leaves first.
    // `nulls: 'last'` is honoured by Prisma's PG driver.
    const orderBy: Prisma.StockLotOrderByWithRelationInput[] =
      query.sort === StockLotSort.NEWEST
        ? [{ receivedAt: 'desc' }, { createdAt: 'desc' }]
        : [
            { expiresAt: { sort: 'asc', nulls: 'last' } },
            { receivedAt: 'asc' },
          ];

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockLot.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: STOCK_LOT_INCLUDE,
      }),
      this.prisma.stockLot.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findExpiring(
    query: ExpiringStockLotQueryDto,
  ): Promise<PaginatedResult<StockLotWithRelations>> {
    const now = new Date();
    const horizon = new Date(now.getTime() + query.days * 24 * 60 * 60 * 1000);

    const where: Prisma.StockLotWhereInput = {
      status: StockLotStatus.ACTIVE,
      expiresAt: { gte: now, lte: horizon },
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockLot.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { expiresAt: 'asc' },
        include: STOCK_LOT_INCLUDE,
      }),
      this.prisma.stockLot.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<StockLotWithRelations> {
    const lot = await this.prisma.stockLot.findUnique({
      where: { id },
      include: STOCK_LOT_INCLUDE,
    });
    if (!lot) throw new NotFoundException('Stock lot not found');
    return lot;
  }

  async adjust(
    user: AuthenticatedUser,
    id: string,
    dto: AdjustStockLotDto,
  ): Promise<StockLotWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.stockLot.findUnique({
        where: { id },
        include: { warehouse: { select: { branchId: true } } },
      });
      if (!lot) throw new NotFoundException('Stock lot not found');
      this.assertMutableLot(lot.status);

      const currentOnHand = this.decToNum(lot.quantityOnHand);
      const nextOnHand = this.round6(dto.quantityOnHand);
      const delta = this.round6(nextOnHand - currentOnHand);
      if (delta === 0) {
        throw new BadRequestException('quantityOnHand is unchanged');
      }

      const nextStatus = this.statusAfterAdjustment(lot.status, nextOnHand);
      await tx.stockLot.update({
        where: { id },
        data: {
          quantityOnHand: new Prisma.Decimal(nextOnHand),
          status: nextStatus,
        },
      });

      await tx.stockMovement.create({
        data: {
          stockLotId: lot.id,
          warehouseId: lot.warehouseId,
          createdByUserId: user.id,
          type: StockMovementType.ADJUSTMENT,
          quantityDelta: new Prisma.Decimal(delta),
          unitCost: lot.unitCost,
          referenceType: 'STOCK_LOT',
          referenceId: lot.id,
          note: this.formatAdjustmentNote(
            dto.reason,
            dto.note,
            currentOnHand,
            nextOnHand,
          ),
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: lot.warehouse.branchId ?? null,
        entityType: 'StockLot',
        entityId: lot.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'adjust',
          reason: dto.reason,
          note: dto.note ?? null,
          previousQuantityOnHand: currentOnHand,
          nextQuantityOnHand: nextOnHand,
          delta,
          previousStatus: lot.status,
          nextStatus,
        },
      });

      return tx.stockLot.findUniqueOrThrow({
        where: { id },
        include: STOCK_LOT_INCLUDE,
      });
    });
  }

  async quarantine(
    user: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<StockLotWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.stockLot.findUnique({
        where: { id },
        include: { warehouse: { select: { branchId: true } } },
      });
      if (!lot) throw new NotFoundException('Stock lot not found');
      if (
        lot.status === StockLotStatus.EXPIRED ||
        lot.status === StockLotStatus.DISCARDED
      ) {
        throw new BadRequestException(`Cannot quarantine a ${lot.status} lot`);
      }
      if (lot.status === StockLotStatus.QUARANTINED) {
        throw new BadRequestException('Lot is already quarantined');
      }

      await tx.stockLot.update({
        where: { id },
        data: { status: StockLotStatus.QUARANTINED },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: lot.warehouse.branchId ?? null,
        entityType: 'StockLot',
        entityId: lot.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'quarantine',
          reason,
          previousStatus: lot.status,
          nextStatus: StockLotStatus.QUARANTINED,
        },
      });

      return tx.stockLot.findUniqueOrThrow({
        where: { id },
        include: STOCK_LOT_INCLUDE,
      });
    });
  }

  async dispose(
    user: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<StockLotWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.stockLot.findUnique({
        where: { id },
        include: { warehouse: { select: { branchId: true } } },
      });
      if (!lot) throw new NotFoundException('Stock lot not found');
      if (lot.status === StockLotStatus.DISCARDED) {
        throw new BadRequestException('Lot is already discarded');
      }

      const quantityOnHand = this.decToNum(lot.quantityOnHand);
      await tx.stockLot.update({
        where: { id },
        data: {
          quantityOnHand: new Prisma.Decimal(0),
          status: StockLotStatus.DISCARDED,
        },
      });

      if (quantityOnHand > 0) {
        await tx.stockMovement.create({
          data: {
            stockLotId: lot.id,
            warehouseId: lot.warehouseId,
            createdByUserId: user.id,
            type: StockMovementType.DISCARD,
            quantityDelta: new Prisma.Decimal(-quantityOnHand),
            unitCost: lot.unitCost,
            referenceType: 'STOCK_LOT',
            referenceId: lot.id,
            note: reason,
          },
        });
      }

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: lot.warehouse.branchId ?? null,
        entityType: 'StockLot',
        entityId: lot.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'dispose',
          reason,
          discardedQuantity: quantityOnHand,
          previousStatus: lot.status,
          nextStatus: StockLotStatus.DISCARDED,
        },
      });

      return tx.stockLot.findUniqueOrThrow({
        where: { id },
        include: STOCK_LOT_INCLUDE,
      });
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private assertMutableLot(status: StockLotStatus) {
    if (
      status === StockLotStatus.EXPIRED ||
      status === StockLotStatus.DISCARDED
    ) {
      throw new BadRequestException(`Cannot change a ${status} lot`);
    }
  }

  private statusAfterAdjustment(
    currentStatus: StockLotStatus,
    nextOnHand: number,
  ): StockLotStatus {
    if (nextOnHand === 0) {
      return currentStatus === StockLotStatus.QUARANTINED
        ? StockLotStatus.QUARANTINED
        : StockLotStatus.EXHAUSTED;
    }
    return currentStatus === StockLotStatus.QUARANTINED
      ? StockLotStatus.QUARANTINED
      : StockLotStatus.ACTIVE;
  }

  private formatAdjustmentNote(
    reason: StockAdjustmentReason,
    note: string | undefined,
    previousQuantity: number,
    nextQuantity: number,
  ) {
    const detail = note?.trim();
    return [
      `Adjustment ${reason}`,
      `(on-hand ${previousQuantity} -> ${nextQuantity})`,
      detail ? `- ${detail}` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private decToNum(value: Prisma.Decimal | number) {
    return typeof value === 'number' ? value : Number(value);
  }

  private round6(value: number) {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private expiresAtFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.StockLotWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeNullableFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { expiresAt: range };
  }
}

export type { StockLot };
