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

  // ───────────────────────── helpers ─────────────────────────
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
