import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  NotificationType,
  Prisma,
  RoleCode,
  StockLotStatus,
  StockMovementType,
  StockTransfer,
  StockTransferStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelStockTransferDto } from './dto/cancel-stock-transfer.dto';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { DispatchStockTransferDto } from './dto/dispatch-stock-transfer.dto';
import { ReceiveStockTransferDto } from './dto/receive-stock-transfer.dto';
import { StockTransferQueryDto } from './dto/stock-transfer-query.dto';

const TRANSFER_INCLUDE = {
  fromWarehouse: { select: { id: true, code: true, name: true } },
  toWarehouse: { select: { id: true, code: true, name: true } },
  fromBranch: { select: { id: true, code: true, name: true } },
  toBranch: { select: { id: true, code: true, name: true } },
  requestedByUser: { select: { id: true, fullName: true, email: true } },
  items: {
    include: {
      stockItem: { select: { id: true, sku: true, name: true } },
      fromStockLot: {
        select: {
          id: true,
          lotCode: true,
          quantityOnHand: true,
          expiresAt: true,
        },
      },
      toStockLot: { select: { id: true, lotCode: true, quantityOnHand: true } },
    },
  },
} satisfies Prisma.StockTransferInclude;

type StockTransferWithRelations = Prisma.StockTransferGetPayload<{
  include: typeof TRANSFER_INCLUDE;
}>;

/**
 * Allowed status transitions. The map is exhaustive — anything not listed
 * here is rejected with a 409. Cancel is allowed from every non-terminal
 * status; receive (with no quantity-received items) is the only path out of
 * IN_TRANSIT.
 */
const ALLOWED_TRANSITIONS: Record<
  StockTransferStatus,
  ReadonlySet<StockTransferStatus>
> = {
  [StockTransferStatus.DRAFT]: new Set([
    StockTransferStatus.REQUESTED,
    StockTransferStatus.CANCELLED,
  ]),
  [StockTransferStatus.REQUESTED]: new Set([
    StockTransferStatus.APPROVED,
    StockTransferStatus.CANCELLED,
  ]),
  [StockTransferStatus.APPROVED]: new Set([
    StockTransferStatus.IN_TRANSIT,
    StockTransferStatus.CANCELLED,
  ]),
  [StockTransferStatus.IN_TRANSIT]: new Set([
    StockTransferStatus.RECEIVED,
    StockTransferStatus.CANCELLED,
  ]),
  [StockTransferStatus.RECEIVED]: new Set(),
  [StockTransferStatus.CANCELLED]: new Set(),
};

@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────── CREATE (DRAFT) ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateStockTransferDto,
  ): Promise<StockTransferWithRelations> {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException(
        'fromWarehouseId and toWarehouseId must be different',
      );
    }

    const [fromWarehouse, toWarehouse] = await Promise.all([
      this.prisma.warehouse.findUnique({
        where: { id: dto.fromWarehouseId },
        select: { id: true, isActive: true, branchId: true },
      }),
      this.prisma.warehouse.findUnique({
        where: { id: dto.toWarehouseId },
        select: { id: true, isActive: true, branchId: true },
      }),
    ]);
    if (!fromWarehouse)
      throw new BadRequestException('fromWarehouse does not exist');
    if (!toWarehouse)
      throw new BadRequestException('toWarehouse does not exist');
    if (!fromWarehouse.isActive) {
      throw new BadRequestException('fromWarehouse is not active');
    }
    if (!toWarehouse.isActive) {
      throw new BadRequestException('toWarehouse is not active');
    }

    // Pre-validate every item against current state. We re-check at dispatch
    // (with row locks) to handle racing consumption between draft + dispatch.
    const lotIds = dto.items.map((i) => i.fromStockLotId);
    const lots = await this.prisma.stockLot.findMany({
      where: { id: { in: lotIds } },
      select: {
        id: true,
        stockItemId: true,
        warehouseId: true,
        status: true,
        quantityOnHand: true,
        stockItem: { select: { isActive: true, deletedAt: true } },
      },
    });
    const lotById = new Map(lots.map((l) => [l.id, l]));

    dto.items.forEach((item, idx) => {
      const lot = lotById.get(item.fromStockLotId);
      if (!lot) {
        throw new BadRequestException(
          `items[${idx}].fromStockLotId does not exist`,
        );
      }
      if (lot.warehouseId !== dto.fromWarehouseId) {
        throw new BadRequestException(
          `items[${idx}]: source lot is not in fromWarehouse`,
        );
      }
      if (lot.stockItemId !== item.stockItemId) {
        throw new BadRequestException(
          `items[${idx}]: stockItemId does not match the source lot`,
        );
      }
      if (lot.status !== StockLotStatus.ACTIVE) {
        throw new BadRequestException(
          `items[${idx}]: source lot is ${lot.status}, cannot transfer`,
        );
      }
      if (lot.stockItem.deletedAt || !lot.stockItem.isActive) {
        throw new BadRequestException(
          `items[${idx}]: stock item is not active`,
        );
      }
      if (item.quantityRequested > decToNum(lot.quantityOnHand)) {
        throw new BadRequestException(
          `items[${idx}]: quantityRequested (${item.quantityRequested}) exceeds source on-hand (${decToNum(lot.quantityOnHand)})`,
        );
      }
    });

    return this.prisma.$transaction(async (tx) => {
      const transferNo = await generateTransferNo(tx, new Date());
      const transfer = await tx.stockTransfer.create({
        data: {
          transferNo,
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          fromBranchId: fromWarehouse.branchId ?? null,
          toBranchId: toWarehouse.branchId ?? null,
          status: StockTransferStatus.DRAFT,
          note: dto.note ?? null,
          items: {
            create: dto.items.map((item) => ({
              stockItemId: item.stockItemId,
              fromWarehouseId: dto.fromWarehouseId,
              toWarehouseId: dto.toWarehouseId,
              fromStockLotId: item.fromStockLotId,
              quantityRequested: new Prisma.Decimal(item.quantityRequested),
            })),
          },
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: fromWarehouse.branchId ?? null,
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: AuditAction.CREATE,
        payload: {
          transferNo,
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          itemCount: dto.items.length,
        },
      });

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: TRANSFER_INCLUDE,
      });
    });
  }

  // ───────────────────────── REQUEST ─────────────────────────
  async request(
    user: AuthenticatedUser,
    id: string,
  ): Promise<StockTransferWithRelations> {
    return this.transitionStatus({
      user,
      id,
      to: StockTransferStatus.REQUESTED,
      mutate: (now) => ({
        status: StockTransferStatus.REQUESTED,
        requestedAt: now,
        requestedByUserId: user.id,
      }),
      auditOp: 'request',
    });
  }

  // ───────────────────────── APPROVE ─────────────────────────
  async approve(
    user: AuthenticatedUser,
    id: string,
  ): Promise<StockTransferWithRelations> {
    return this.transitionStatus({
      user,
      id,
      to: StockTransferStatus.APPROVED,
      mutate: (now) => ({
        status: StockTransferStatus.APPROVED,
        approvedAt: now,
      }),
      auditOp: 'approve',
    });
  }

  // ───────────────────────── DISPATCH ─────────────────────────
  async dispatch(
    user: AuthenticatedUser,
    id: string,
    dto: DispatchStockTransferDto,
  ): Promise<StockTransferWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!transfer) throw new NotFoundException('Stock transfer not found');
      this.assertTransition(transfer.status, StockTransferStatus.IN_TRANSIT);

      const itemMap = new Map(transfer.items.map((it) => [it.id, it]));
      const dispatchByItemId = new Map(dto.items.map((d) => [d.itemId, d]));

      // Every transfer item must be addressed in the dispatch payload — even
      // a 0 send is rejected by the DTO validator, so omitted items get
      // explicitly flagged here.
      for (const item of transfer.items) {
        const d = dispatchByItemId.get(item.id);
        if (!d) {
          throw new BadRequestException(
            `Missing dispatch entry for item ${item.id}`,
          );
        }
        const requested = decToNum(item.quantityRequested);
        if (d.quantitySent > requested) {
          throw new BadRequestException(
            `Item ${item.id}: quantitySent (${d.quantitySent}) exceeds quantityRequested (${requested})`,
          );
        }
      }

      // Lock all source lots for the duration of the tx so we can't
      // double-spend across concurrent dispatches.
      const sourceLotIds = Array.from(
        new Set(transfer.items.map((it) => it.fromStockLotId)),
      );
      for (const lotId of sourceLotIds) {
        await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${lotId} FOR UPDATE`;
      }

      const lots = await tx.stockLot.findMany({
        where: { id: { in: sourceLotIds } },
      });
      const lotById = new Map(lots.map((l) => [l.id, l]));

      // Aggregate sent quantity per lot first, since multiple items may share
      // the same source lot — we want one combined deduction, not N individual.
      const aggregateByLot = new Map<string, number>();
      for (const item of transfer.items) {
        const d = dispatchByItemId.get(item.id)!;
        aggregateByLot.set(
          item.fromStockLotId,
          (aggregateByLot.get(item.fromStockLotId) ?? 0) + d.quantitySent,
        );
      }

      for (const [lotId, totalSent] of aggregateByLot) {
        const lot = lotById.get(lotId);
        if (!lot)
          throw new BadRequestException(`Source lot ${lotId} disappeared`);
        if (lot.status !== StockLotStatus.ACTIVE) {
          throw new BadRequestException(
            `Source lot ${lotId} is ${lot.status}, cannot dispatch`,
          );
        }
        const onHand = decToNum(lot.quantityOnHand);
        if (totalSent > onHand) {
          throw new BadRequestException(
            `Insufficient stock in lot ${lotId} (need ${totalSent}, on hand ${onHand})`,
          );
        }
      }

      const now = new Date();

      // Apply per-item updates + per-lot deductions + TRANSFER_OUT movements.
      for (const item of transfer.items) {
        const d = dispatchByItemId.get(item.id)!;
        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: { quantitySent: new Prisma.Decimal(d.quantitySent) },
        });

        await tx.stockMovement.create({
          data: {
            stockLotId: item.fromStockLotId,
            warehouseId: transfer.fromWarehouseId,
            createdByUserId: user.id,
            type: StockMovementType.TRANSFER_OUT,
            quantityDelta: new Prisma.Decimal(-d.quantitySent),
            referenceType: 'STOCK_TRANSFER',
            referenceId: transfer.id,
            note: dto.note ?? null,
          },
        });
      }

      for (const [lotId, totalSent] of aggregateByLot) {
        const lot = lotById.get(lotId)!;
        const newOnHand = round6(decToNum(lot.quantityOnHand) - totalSent);
        const exhausted = newOnHand === 0;
        await tx.stockLot.update({
          where: { id: lotId },
          data: {
            quantityOnHand: new Prisma.Decimal(newOnHand),
            ...(exhausted ? { status: StockLotStatus.EXHAUSTED } : {}),
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: StockTransferStatus.IN_TRANSIT, dispatchedAt: now },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: transfer.fromBranchId ?? null,
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'dispatch',
          dispatchedAt: now.toISOString(),
          dispatchedByUserId: user.id,
          itemSends: Object.fromEntries(
            dto.items.map((d) => [d.itemId, d.quantitySent]),
          ),
        },
      });

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: TRANSFER_INCLUDE,
      });
    });
  }

  // ───────────────────────── RECEIVE ─────────────────────────
  async receive(
    user: AuthenticatedUser,
    id: string,
    dto: ReceiveStockTransferDto,
  ): Promise<StockTransferWithRelations> {
    const result = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: {
          items: { include: { fromStockLot: true } },
        },
      });
      if (!transfer) throw new NotFoundException('Stock transfer not found');
      this.assertTransition(transfer.status, StockTransferStatus.RECEIVED);

      const receiveByItemId = new Map(dto.items.map((d) => [d.itemId, d]));

      for (const item of transfer.items) {
        const d = receiveByItemId.get(item.id);
        if (!d) {
          throw new BadRequestException(
            `Missing receive entry for item ${item.id}`,
          );
        }
        const sent = item.quantitySent ? decToNum(item.quantitySent) : 0;
        if (sent <= 0) {
          throw new BadRequestException(
            `Item ${item.id} was not dispatched; cannot receive`,
          );
        }
        if (d.quantityReceived > sent) {
          throw new BadRequestException(
            `Item ${item.id}: quantityReceived (${d.quantityReceived}) exceeds quantitySent (${sent})`,
          );
        }
      }

      const now = new Date();

      for (const item of transfer.items) {
        const d = receiveByItemId.get(item.id)!;

        // Mint a destination lot whose code embeds the source lot to keep
        // the audit chain tight. Caller can override via `toLotCode`.
        const baseToCode = d.toLotCode ?? `${item.fromStockLot.lotCode}-T`;
        const toLotCode = await this.uniqueLotCodeForWarehouse(
          tx,
          transfer.toWarehouseId,
          baseToCode,
        );

        const toLot = await tx.stockLot.create({
          data: {
            stockItemId: item.stockItemId,
            warehouseId: transfer.toWarehouseId,
            lotCode: toLotCode,
            parentLotId: item.fromStockLotId,
            supplierId: item.fromStockLot.supplierId,
            purchaseReceiptId: item.fromStockLot.purchaseReceiptId,
            purchaseReference: item.fromStockLot.purchaseReference,
            quantityReceived: new Prisma.Decimal(d.quantityReceived),
            quantityOnHand: new Prisma.Decimal(d.quantityReceived),
            unitCost: item.fromStockLot.unitCost,
            receivedAt: now,
            manufacturedAt: item.fromStockLot.manufacturedAt,
            expiresAt: item.fromStockLot.expiresAt,
            status: StockLotStatus.ACTIVE,
          },
        });

        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: {
            quantityReceived: new Prisma.Decimal(d.quantityReceived),
            toStockLotId: toLot.id,
          },
        });

        await tx.stockMovement.create({
          data: {
            stockLotId: toLot.id,
            warehouseId: transfer.toWarehouseId,
            createdByUserId: user.id,
            type: StockMovementType.TRANSFER_IN,
            quantityDelta: new Prisma.Decimal(d.quantityReceived),
            unitCost: item.fromStockLot.unitCost,
            referenceType: 'STOCK_TRANSFER',
            referenceId: transfer.id,
            note: dto.note ?? null,
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: StockTransferStatus.RECEIVED, receivedAt: now },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: transfer.toBranchId ?? null,
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'receive',
          receivedAt: now.toISOString(),
          receivedByUserId: user.id,
          itemReceives: Object.fromEntries(
            dto.items.map((d) => [d.itemId, d.quantityReceived]),
          ),
        },
      });

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: TRANSFER_INCLUDE,
      });
    });

    // Post-commit alert to receiving branch managers (and central
    // stock hub for cross-branch transfers). Idempotent via dedupeKey.
    if (result.toBranchId) {
      const recipients = await this.findStockManagers(result.toBranchId);
      if (recipients.length > 0) {
        await this.notifications.notifyMany(recipients, {
          title: `Stock transfer received: ${result.transferNo}`,
          message: `${result.items.length} item(s) received at ${result.toWarehouse?.code ?? 'destination'}.`,
          type: NotificationType.STOCK_TRANSFER,
          branchId: result.toBranchId,
          metadata: {
            stockTransferId: result.id,
            transferNo: result.transferNo,
            toWarehouseId: result.toWarehouseId,
          },
          dedupeKeyPrefix: `STOCK_TRANSFER_RECEIVED|${result.id}`,
        });
      }
    }
    return result;
  }

  private async findStockManagers(branchId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: {
        role: {
          code: {
            in: [
              RoleCode.BRANCH_MANAGER,
              RoleCode.SUPER_BRANCH_MANAGER,
              RoleCode.ADMIN,
              RoleCode.CENTRAL_STOCK_HUB,
            ],
          },
        },
        OR: [{ branchId }, { branchId: null }],
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    return Array.from(new Set(rows.map((r) => r.userId)));
  }

  // ───────────────────────── CANCEL ─────────────────────────
  async cancel(
    user: AuthenticatedUser,
    id: string,
    dto: CancelStockTransferDto,
  ): Promise<StockTransferWithRelations> {
    return this.transitionStatus({
      user,
      id,
      to: StockTransferStatus.CANCELLED,
      mutate: () => ({ status: StockTransferStatus.CANCELLED }),
      auditOp: 'cancel',
      auditExtra: { reason: dto.reason ?? null },
    });
  }

  // ───────────────────────── QUERY ─────────────────────────
  async findAll(
    query: StockTransferQueryDto,
  ): Promise<PaginatedResult<StockTransferWithRelations>> {
    const where: Prisma.StockTransferWhereInput = {
      ...(query.fromWarehouseId
        ? { fromWarehouseId: query.fromWarehouseId }
        : {}),
      ...(query.toWarehouseId ? { toWarehouseId: query.toWarehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { transferNo: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...this.dateRangeFilter(query.from, query.to),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: TRANSFER_INCLUDE,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<StockTransferWithRelations> {
    const transfer = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer) throw new NotFoundException('Stock transfer not found');
    return transfer;
  }

  // ────────────────────── private helpers ──────────────────────
  private assertTransition(
    from: StockTransferStatus,
    to: StockTransferStatus,
  ): void {
    if (!ALLOWED_TRANSITIONS[from].has(to)) {
      throw new ConflictException(
        `Invalid transfer status transition: ${from} → ${to}`,
      );
    }
  }

  private async transitionStatus(args: {
    user: AuthenticatedUser;
    id: string;
    to: StockTransferStatus;
    mutate: (now: Date) => Prisma.StockTransferUpdateInput;
    auditOp: string;
    auditExtra?: Prisma.InputJsonValue;
  }): Promise<StockTransferWithRelations> {
    const { user, id, to, mutate, auditOp, auditExtra } = args;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.stockTransfer.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          fromBranchId: true,
        },
      });
      if (!current) throw new NotFoundException('Stock transfer not found');
      this.assertTransition(current.status, to);

      const now = new Date();
      await tx.stockTransfer.update({ where: { id }, data: mutate(now) });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: current.fromBranchId ?? null,
        entityType: 'StockTransfer',
        entityId: id,
        action: AuditAction.UPDATE,
        payload: {
          op: auditOp,
          from: current.status,
          to,
          at: now.toISOString(),
          actorUserId: user.id,
          ...(auditExtra &&
          typeof auditExtra === 'object' &&
          !Array.isArray(auditExtra)
            ? (auditExtra as Record<string, Prisma.InputJsonValue>)
            : {}),
        },
      });

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id },
        include: TRANSFER_INCLUDE,
      });
    });
  }

  private dateRangeFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.StockTransferWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { createdAt: range };
  }

  /**
   * Mints a unique destination lot code by appending a `-NNN` suffix when the
   * caller's preferred code is taken. Operates inside the transaction so we
   * read uncommitted lots from the same receive call.
   */
  private async uniqueLotCodeForWarehouse(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    base: string,
  ): Promise<string> {
    const existing = await tx.stockLot.findMany({
      where: { warehouseId, lotCode: { startsWith: base } },
      select: { lotCode: true },
    });
    const taken = new Set(existing.map((l) => l.lotCode));
    if (!taken.has(base)) return base;
    for (let n = 1; n <= 999; n += 1) {
      const candidate = `${base}${String(n).padStart(3, '0')}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new ConflictException(
      `Could not derive a unique lot code for "${base}" (>999 collisions)`,
    );
  }
}

// ─────────────────────── module-private utils ───────────────────────
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(v.toString());
};

const formatYYYYMMDD = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * Concurrency-safe per-day transfer-number generator: `TR-YYYYMMDD-####`.
 */
export async function generateTransferNo(
  tx: Prisma.TransactionClient,
  at: Date,
): Promise<string> {
  const yyyymmdd = formatYYYYMMDD(at);
  const lockKey = `stock-transfer-no-${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const prefix = `TR-${yyyymmdd}-`;
  const last = await tx.stockTransfer.findFirst({
    where: { transferNo: { startsWith: prefix } },
    orderBy: { transferNo: 'desc' },
    select: { transferNo: true },
  });
  const lastSeq = last ? parseInt(last.transferNo.slice(prefix.length), 10) : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

export type { StockTransfer };
