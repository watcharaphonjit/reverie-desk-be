import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  PurchaseReceipt,
  StockLotStatus,
  StockMovementType,
} from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePurchaseReceiptDto,
  PurchaseReceiptItemDto,
} from './dto/create-purchase-receipt.dto';
import { PurchaseReceiptQueryDto } from './dto/purchase-receipt-query.dto';

const RECEIPT_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  stockLots: {
    select: {
      id: true,
      lotCode: true,
      quantityReceived: true,
      quantityOnHand: true,
    },
  },
} satisfies Prisma.PurchaseReceiptInclude;

type PurchaseReceiptWithRelations = Prisma.PurchaseReceiptGetPayload<{
  include: typeof RECEIPT_INCLUDE;
}>;

@Injectable()
export class PurchaseReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a purchase receipt header. When `items` is supplied, the entire
   * goods-receiving flow runs in a single transaction:
   *   1. Allocate `PR-YYYYMMDD-####` reference number (advisory-locked).
   *   2. Insert the `PurchaseReceipt` header.
   *   3. For each item — validate stock item / warehouse / supplier, ensure
   *      `lotCode` is unique within the destination warehouse (and within
   *      this batch), create a `StockLot`, and write a `PURCHASE_IN`
   *      `StockMovement` referencing the receipt.
   *   4. Audit the receipt + each lot creation.
   *
   * If any step throws, the entire batch — header included — is rolled back.
   * That's the "transaction safety" guarantee the spec asks for.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreatePurchaseReceiptDto,
  ): Promise<PurchaseReceiptWithRelations> {
    if (dto.branchId) await this.assertBranchExists(dto.branchId);
    if (dto.supplierId) await this.assertSupplierExists(dto.supplierId);

    if (dto.items && dto.items.length > 0) {
      this.validateItemBatchPreflight(dto.items, dto.warehouseId);
    }

    const purchasedAt = dto.purchasedAt
      ? new Date(dto.purchasedAt)
      : new Date();

    return this.prisma.$transaction(async (tx) => {
      const referenceNo = await generatePurchaseReceiptNo(tx, purchasedAt);
      const receipt = await tx.purchaseReceipt.create({
        data: {
          referenceNo,
          branchId: dto.branchId ?? null,
          supplierId: dto.supplierId ?? null,
          purchasedAt,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: receipt.branchId,
        entityType: 'PurchaseReceipt',
        entityId: receipt.id,
        action: AuditAction.CREATE,
        payload: {
          referenceNo: receipt.referenceNo,
          supplierId: receipt.supplierId,
          purchasedAt: receipt.purchasedAt?.toISOString() ?? null,
          itemCount: dto.items?.length ?? 0,
        },
      });

      if (dto.items && dto.items.length > 0) {
        for (const item of dto.items) {
          await this.receiveItemInTx(tx, user, receipt.id, dto, item);
        }
      }

      return tx.purchaseReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: RECEIPT_INCLUDE,
      });
    });
  }

  /**
   * Validates a multi-item batch *before* the transaction opens so we fail fast
   * on schema-level mistakes (e.g., missing warehouse, intra-batch lotCode
   * collisions) without holding a tx and a `pg_advisory_xact_lock`.
   */
  private validateItemBatchPreflight(
    items: PurchaseReceiptItemDto[],
    receiptWarehouseId: string | undefined,
  ): void {
    const seen = new Map<string, number>(); // `${warehouseId}::${lotCode}` -> firstIdx
    items.forEach((item, idx) => {
      const warehouseId = item.warehouseId ?? receiptWarehouseId;
      if (!warehouseId) {
        throw new BadRequestException(
          `items[${idx}]: warehouseId is required (set it on the receipt or per-item)`,
        );
      }
      if (item.quantityReceived <= 0) {
        throw new BadRequestException(
          `items[${idx}]: quantityReceived must be > 0`,
        );
      }
      if (item.unitCost < 0) {
        throw new BadRequestException(`items[${idx}]: unitCost must be >= 0`);
      }
      const key = `${warehouseId}::${item.lotCode}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        throw new ConflictException(
          `items[${idx}].lotCode "${item.lotCode}" duplicates items[${existing}] for the same warehouse`,
        );
      }
      seen.set(key, idx);
    });
  }

  /**
   * Validates and writes a single line of a multi-item receive inside an
   * existing Prisma transaction. Caller is responsible for the surrounding tx.
   */
  private async receiveItemInTx(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    receiptId: string,
    dto: CreatePurchaseReceiptDto,
    item: PurchaseReceiptItemDto,
  ): Promise<void> {
    const warehouseId = item.warehouseId ?? dto.warehouseId;
    if (!warehouseId) {
      // Should be unreachable thanks to preflight, but guard anyway.
      throw new BadRequestException('warehouseId resolution failed');
    }

    const stockItem = await tx.stockItem.findFirst({
      where: { id: item.stockItemId, deletedAt: null },
      select: { id: true, isActive: true },
    });
    if (!stockItem) {
      throw new BadRequestException(
        `Stock item ${item.stockItemId} does not exist`,
      );
    }
    if (!stockItem.isActive) {
      throw new BadRequestException(
        `Stock item ${item.stockItemId} is not active`,
      );
    }

    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, isActive: true, branchId: true },
    });
    if (!warehouse) {
      throw new BadRequestException(`Warehouse ${warehouseId} does not exist`);
    }
    if (!warehouse.isActive) {
      throw new BadRequestException(`Warehouse ${warehouseId} is not active`);
    }

    const lotConflict = await tx.stockLot.findFirst({
      where: { warehouseId, lotCode: item.lotCode },
      select: { id: true },
    });
    if (lotConflict) {
      throw new ConflictException(
        `lotCode "${item.lotCode}" already exists in warehouse ${warehouseId}`,
      );
    }

    const lot = await tx.stockLot.create({
      data: {
        stockItemId: item.stockItemId,
        warehouseId,
        lotCode: item.lotCode,
        supplierId: dto.supplierId ?? null,
        purchaseReceiptId: receiptId,
        purchaseReference: item.purchaseReference ?? null,
        quantityReceived: new Prisma.Decimal(item.quantityReceived),
        quantityOnHand: new Prisma.Decimal(item.quantityReceived),
        unitCost: new Prisma.Decimal(item.unitCost),
        receivedAt: dto.purchasedAt ? new Date(dto.purchasedAt) : new Date(),
        manufacturedAt: item.manufacturedAt
          ? new Date(item.manufacturedAt)
          : null,
        expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
        status: StockLotStatus.ACTIVE,
      },
    });

    await tx.stockMovement.create({
      data: {
        stockLotId: lot.id,
        warehouseId: lot.warehouseId,
        createdByUserId: user.id,
        type: StockMovementType.PURCHASE_IN,
        quantityDelta: new Prisma.Decimal(item.quantityReceived),
        unitCost: new Prisma.Decimal(item.unitCost),
        referenceType: 'PURCHASE_RECEIPT',
        referenceId: receiptId,
        note: item.note ?? null,
      },
    });

    await this.audit.recordWith(tx, {
      actorUserId: user.id,
      branchId: warehouse.branchId ?? null,
      entityType: 'StockLot',
      entityId: lot.id,
      action: AuditAction.CREATE,
      payload: {
        op: 'receive-via-purchase-receipt',
        purchaseReceiptId: receiptId,
        lotCode: lot.lotCode,
        warehouseId,
        stockItemId: lot.stockItemId,
        quantityReceived: item.quantityReceived,
        unitCost: item.unitCost,
      },
    });
  }

  async findAll(
    query: PurchaseReceiptQueryDto,
  ): Promise<PaginatedResult<PurchaseReceiptWithRelations>> {
    const where: Prisma.PurchaseReceiptWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...this.dateRangeFilter(query.from, query.to),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchaseReceipt.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: RECEIPT_INCLUDE,
      }),
      this.prisma.purchaseReceipt.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<PurchaseReceiptWithRelations> {
    const receipt = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      include: RECEIPT_INCLUDE,
    });
    if (!receipt) throw new NotFoundException('Purchase receipt not found');
    return receipt;
  }

  // ───────────────────────── helpers ─────────────────────────
  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!branch) throw new BadRequestException('Branch does not exist');
  }

  private async assertSupplierExists(supplierId: string): Promise<void> {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true },
    });
    if (!supplier) throw new BadRequestException('Supplier does not exist');
  }

  private dateRangeFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.PurchaseReceiptWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeNullableFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { purchasedAt: range };
  }
}

// ─────────────────────── module-private utils ───────────────────────

const formatYYYYMMDD = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * Concurrency-safe per-day reference-number generator. Format: `PR-YYYYMMDD-####`.
 * The lock key includes the day so concurrent inserts on the same day serialise,
 * but inserts on different days don't contend.
 */
export async function generatePurchaseReceiptNo(
  tx: Prisma.TransactionClient,
  purchasedAt: Date,
): Promise<string> {
  const yyyymmdd = formatYYYYMMDD(purchasedAt);
  const lockKey = `purchase-receipt-no-${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const prefix = `PR-${yyyymmdd}-`;
  const last = await tx.purchaseReceipt.findFirst({
    where: { referenceNo: { startsWith: prefix } },
    orderBy: { referenceNo: 'desc' },
    select: { referenceNo: true },
  });
  const lastSeq = last
    ? parseInt(last.referenceNo.slice(prefix.length), 10)
    : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// keep the Prisma type re-exported for downstream consumers
export type { PurchaseReceipt };
