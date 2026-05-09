import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  ConsumptionStrategy,
  OpenedContainer,
  OpenedContainerStatus,
  Prisma,
  ServiceEventStatus,
  StockLotStatus,
  StockMovementType,
} from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CloseContainerDto } from './dto/close-container.dto';
import { OpenContainerDto } from './dto/open-container.dto';
import { OpenedContainerQueryDto } from './dto/opened-container-query.dto';
import { UseContainerDto } from './dto/use-container.dto';

const CONTAINER_INCLUDE = {
  stockItem: {
    select: {
      id: true,
      sku: true,
      name: true,
      consumptionStrategy: true,
      conversionFactor: true,
    },
  },
  stockLot: {
    select: {
      id: true,
      lotCode: true,
      status: true,
      quantityOnHand: true,
      expiresAt: true,
    },
  },
  warehouse: { select: { id: true, code: true, name: true } },
  openedByUser: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.OpenedContainerInclude;

type OpenedContainerWithRelations = Prisma.OpenedContainerGetPayload<{
  include: typeof CONTAINER_INCLUDE;
}>;

const PARTIAL_STRATEGIES: ReadonlySet<ConsumptionStrategy> = new Set([
  ConsumptionStrategy.PARTIAL_ALLOWED,
  ConsumptionStrategy.PARTIAL_REQUIRED,
]);

@Injectable()
export class OpenedContainersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── OPEN ───────────────────────────
  async open(
    user: AuthenticatedUser,
    dto: OpenContainerDto,
  ): Promise<OpenedContainerWithRelations> {
    const lot = await this.prisma.stockLot.findUnique({
      where: { id: dto.stockLotId },
      include: {
        stockItem: {
          select: {
            id: true,
            isActive: true,
            consumptionStrategy: true,
            conversionFactor: true,
            secondaryUnitId: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!lot) throw new BadRequestException('Stock lot does not exist');
    if (lot.status !== StockLotStatus.ACTIVE) {
      throw new BadRequestException(
        `Stock lot is not ACTIVE (current: ${lot.status})`,
      );
    }
    if (lot.stockItem.deletedAt) {
      throw new BadRequestException('Stock item has been deleted');
    }
    if (!PARTIAL_STRATEGIES.has(lot.stockItem.consumptionStrategy)) {
      throw new BadRequestException(
        `Stock item consumption strategy ${lot.stockItem.consumptionStrategy} does not allow partial usage`,
      );
    }
    if (!lot.stockItem.secondaryUnitId || !lot.stockItem.conversionFactor) {
      throw new BadRequestException(
        'Stock item must define a secondary unit + conversionFactor to be opened',
      );
    }

    const conversionFactor = decToNum(lot.stockItem.conversionFactor);
    if (conversionFactor <= 0) {
      throw new BadRequestException(
        'Stock item conversionFactor must be greater than 0',
      );
    }

    // If the caller passed any of the optional cross-check fields, they
    // must agree with what we'd derive from the lot — silently ignoring a
    // mismatch would let the front-end develop subtly incorrect mental
    // models of inventory.
    if (dto.stockItemId && dto.stockItemId !== lot.stockItemId) {
      throw new BadRequestException(
        'stockItemId does not match the lot.stockItemId',
      );
    }
    if (dto.warehouseId && dto.warehouseId !== lot.warehouseId) {
      throw new BadRequestException(
        'warehouseId does not match the lot.warehouseId',
      );
    }
    if (
      dto.initialQtyPrimary != null &&
      Math.abs(dto.initialQtyPrimary - conversionFactor) > 1e-6
    ) {
      throw new BadRequestException(
        `initialQtyPrimary (${dto.initialQtyPrimary}) must match stock item conversionFactor (${conversionFactor})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Row-lock the lot for the duration of the transaction so two concurrent
      // opens can't both see quantityOnHand=1 and double-deduct.
      await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${lot.id} FOR UPDATE`;

      const lockedLot = await tx.stockLot.findUnique({
        where: { id: lot.id },
        select: {
          id: true,
          status: true,
          quantityOnHand: true,
          warehouseId: true,
        },
      });
      if (!lockedLot) throw new BadRequestException('Stock lot disappeared');
      if (lockedLot.status !== StockLotStatus.ACTIVE) {
        throw new BadRequestException(
          `Stock lot is not ACTIVE (current: ${lockedLot.status})`,
        );
      }
      const onHand = decToNum(lockedLot.quantityOnHand);
      if (onHand <= 0) {
        throw new BadRequestException('Stock lot has no on-hand quantity');
      }

      const newOnHand = round6(onHand - 1);
      const exhausted = newOnHand === 0;

      await tx.stockLot.update({
        where: { id: lockedLot.id },
        data: {
          quantityOnHand: new Prisma.Decimal(newOnHand),
          ...(exhausted ? { status: StockLotStatus.EXHAUSTED } : {}),
        },
      });

      const container = await tx.openedContainer.create({
        data: {
          stockItemId: lot.stockItemId,
          stockLotId: lot.id,
          warehouseId: lockedLot.warehouseId,
          openedByUserId: user.id,
          expiryAt: dto.expiryAt ? new Date(dto.expiryAt) : null,
          initialQtyPrimary: new Prisma.Decimal(conversionFactor),
          remainingQtyPrimary: new Prisma.Decimal(conversionFactor),
          status: OpenedContainerStatus.ACTIVE,
          note: dto.note ?? null,
        },
        include: CONTAINER_INCLUDE,
      });

      // Reflect the lot deduction as a clinical-usage movement; reference the
      // new container so the audit trail clearly attributes the -1 to it.
      await tx.stockMovement.create({
        data: {
          stockLotId: lot.id,
          warehouseId: lockedLot.warehouseId,
          createdByUserId: user.id,
          type: StockMovementType.CLINICAL_USAGE,
          quantityDelta: new Prisma.Decimal(-1),
          referenceType: 'OPENED_CONTAINER',
          referenceId: container.id,
          note: dto.note ?? null,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'OpenedContainer',
        entityId: container.id,
        action: AuditAction.CREATE,
        payload: {
          stockLotId: lot.id,
          stockItemId: lot.stockItemId,
          warehouseId: lockedLot.warehouseId,
          initialQtyPrimary: conversionFactor,
        },
      });

      return container;
    });
  }

  // ─────────────────────────── USE ────────────────────────────
  async use(
    user: AuthenticatedUser,
    id: string,
    dto: UseContainerDto,
  ): Promise<OpenedContainerWithRelations> {
    if (dto.quantityPrimaryUsed <= 0) {
      throw new BadRequestException('quantityPrimaryUsed must be > 0');
    }

    const event = await this.prisma.customerServiceEvent.findUnique({
      where: { id: dto.customerServiceEventId },
      select: {
        id: true,
        status: true,
        serviceId: true,
        customerId: true,
      },
    });
    if (!event) {
      throw new BadRequestException('Customer service event does not exist');
    }
    if (event.status !== ServiceEventStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Stock can only be drawn while the event is IN_PROGRESS (current: ${event.status})`,
      );
    }
    if (event.serviceId !== dto.serviceId) {
      throw new BadRequestException(
        'serviceId does not match the customerServiceEvent.serviceId',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM opened_containers WHERE id = ${id} FOR UPDATE`;

      const container = await tx.openedContainer.findUnique({
        where: { id },
        select: {
          id: true,
          stockItemId: true,
          stockLotId: true,
          warehouseId: true,
          status: true,
          remainingQtyPrimary: true,
          expiryAt: true,
        },
      });
      if (!container) throw new NotFoundException('Opened container not found');
      if (container.status !== OpenedContainerStatus.ACTIVE) {
        throw new ConflictException(
          `Container is not ACTIVE (current: ${container.status})`,
        );
      }
      if (container.expiryAt && container.expiryAt.getTime() < Date.now()) {
        throw new BadRequestException(
          'Container in-use shelf life has expired; mark it EXPIRED first',
        );
      }

      const remaining = decToNum(container.remainingQtyPrimary);
      if (dto.quantityPrimaryUsed > remaining) {
        throw new BadRequestException(
          `Insufficient remaining quantity (requested ${dto.quantityPrimaryUsed}, remaining ${remaining})`,
        );
      }

      const newRemaining = round6(remaining - dto.quantityPrimaryUsed);
      const isEmpty = newRemaining === 0;

      await tx.openedContainer.update({
        where: { id: container.id },
        data: {
          remainingQtyPrimary: new Prisma.Decimal(newRemaining),
          ...(isEmpty ? { status: OpenedContainerStatus.EMPTY } : {}),
        },
      });

      await tx.serviceStockUsage.create({
        data: {
          customerServiceEventId: event.id,
          serviceId: event.serviceId,
          stockItemId: container.stockItemId,
          stockLotId: container.stockLotId,
          openedContainerId: container.id,
          quantityPrimaryUsed: new Prisma.Decimal(dto.quantityPrimaryUsed),
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'OpenedContainer',
        entityId: container.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'use',
          customerServiceEventId: event.id,
          quantityPrimaryUsed: dto.quantityPrimaryUsed,
          remainingAfter: newRemaining,
          becameEmpty: isEmpty,
        },
      });

      return tx.openedContainer.findUniqueOrThrow({
        where: { id: container.id },
        include: CONTAINER_INCLUDE,
      });
    });
  }

  // ───────────────────────── DISCARD ──────────────────────────
  async discard(
    user: AuthenticatedUser,
    id: string,
    dto: CloseContainerDto,
  ): Promise<OpenedContainerWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM opened_containers WHERE id = ${id} FOR UPDATE`;

      const container = await tx.openedContainer.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          stockLotId: true,
          warehouseId: true,
          remainingQtyPrimary: true,
        },
      });
      if (!container) throw new NotFoundException('Opened container not found');
      if (container.status !== OpenedContainerStatus.ACTIVE) {
        throw new ConflictException(
          `Container cannot be discarded from status ${container.status}`,
        );
      }

      await tx.openedContainer.update({
        where: { id: container.id },
        data: { status: OpenedContainerStatus.DISCARDED },
      });

      // The lot's quantityOnHand was already decremented at open time, so this
      // movement is informational — quantityDelta=0 — and exists purely so the
      // discard event is auditable in the StockMovement timeline.
      await tx.stockMovement.create({
        data: {
          stockLotId: container.stockLotId,
          warehouseId: container.warehouseId,
          createdByUserId: user.id,
          type: StockMovementType.DISCARD,
          quantityDelta: new Prisma.Decimal(0),
          referenceType: 'OPENED_CONTAINER',
          referenceId: container.id,
          note:
            dto.reason ??
            `Discarded open container with ${decToNum(container.remainingQtyPrimary)} primary units remaining`,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'OpenedContainer',
        entityId: container.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'discard',
          remainingAtDiscard: decToNum(container.remainingQtyPrimary),
          reason: dto.reason ?? null,
        },
      });

      return tx.openedContainer.findUniqueOrThrow({
        where: { id: container.id },
        include: CONTAINER_INCLUDE,
      });
    });
  }

  // ───────────────────────── EXPIRE ───────────────────────────
  async expire(
    user: AuthenticatedUser,
    id: string,
    dto: CloseContainerDto,
  ): Promise<OpenedContainerWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM opened_containers WHERE id = ${id} FOR UPDATE`;

      const container = await tx.openedContainer.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          remainingQtyPrimary: true,
        },
      });
      if (!container) throw new NotFoundException('Opened container not found');
      if (container.status !== OpenedContainerStatus.ACTIVE) {
        throw new ConflictException(
          `Container cannot be expired from status ${container.status}`,
        );
      }

      await tx.openedContainer.update({
        where: { id: container.id },
        data: { status: OpenedContainerStatus.EXPIRED },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'OpenedContainer',
        entityId: container.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'expire',
          remainingAtExpire: decToNum(container.remainingQtyPrimary),
          reason: dto.reason ?? null,
        },
      });

      return tx.openedContainer.findUniqueOrThrow({
        where: { id: container.id },
        include: CONTAINER_INCLUDE,
      });
    });
  }

  // ────────────────────────── QUERIES ─────────────────────────
  async findAll(
    query: OpenedContainerQueryDto,
  ): Promise<PaginatedResult<OpenedContainerWithRelations>> {
    const where: Prisma.OpenedContainerWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
      ...(query.stockLotId ? { stockLotId: query.stockLotId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.expiryAtFilter(query.expiringFrom, query.expiringTo),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.openedContainer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ openedAt: 'desc' }],
        include: CONTAINER_INCLUDE,
      }),
      this.prisma.openedContainer.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<OpenedContainerWithRelations> {
    const container = await this.prisma.openedContainer.findUnique({
      where: { id },
      include: CONTAINER_INCLUDE,
    });
    if (!container) throw new NotFoundException('Opened container not found');
    return container;
  }

  // ────────────────────────── helpers ─────────────────────────
  private expiryAtFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.OpenedContainerWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeNullableFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { expiryAt: range };
  }
}

// ─────────────────────── module-private utils ───────────────────────
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(v.toString());
};

export type { OpenedContainer };
