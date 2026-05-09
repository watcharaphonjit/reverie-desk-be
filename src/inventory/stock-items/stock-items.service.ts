import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, StockItem } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateStockItemDto } from './dto/create-stock-item.dto';
import { StockItemQueryDto } from './dto/stock-item-query.dto';
import { UpdateStockItemDto } from './dto/update-stock-item.dto';

const STOCK_ITEM_INCLUDE = {
  primaryUnit: { select: { id: true, code: true, label: true } },
  secondaryUnit: { select: { id: true, code: true, label: true } },
} satisfies Prisma.StockItemInclude;

type StockItemWithUnits = Prisma.StockItemGetPayload<{
  include: typeof STOCK_ITEM_INCLUDE;
}>;

@Injectable()
export class StockItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateStockItemDto,
  ): Promise<StockItemWithUnits> {
    await this.assertSkuAvailable(dto.sku);
    await this.assertUnitsValid(dto.primaryUnitId, dto.secondaryUnitId);
    this.assertConversionFactorRule(dto.secondaryUnitId, dto.conversionFactor);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.stockItem.create({
        data: {
          sku: dto.sku,
          name: dto.name,
          type: dto.type,
          primaryUnitId: dto.primaryUnitId,
          secondaryUnitId: dto.secondaryUnitId ?? null,
          conversionFactor: dto.conversionFactor ?? null,
          consumptionStrategy: dto.consumptionStrategy,
          isSellable: dto.isSellable ?? false,
          trackLot: dto.trackLot ?? true,
          isActive: dto.isActive ?? true,
        },
        include: STOCK_ITEM_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'StockItem',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          sku: created.sku,
          name: created.name,
          type: created.type,
          consumptionStrategy: created.consumptionStrategy,
          isSellable: created.isSellable,
        },
      });

      return created;
    });
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    query: StockItemQueryDto,
  ): Promise<PaginatedResult<StockItemWithUnits>> {
    const where: Prisma.StockItemWhereInput = {
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.isSellable !== undefined
        ? { isSellable: query.isSellable }
        : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { sku: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockItem.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { sku: 'asc' },
        include: STOCK_ITEM_INCLUDE,
      }),
      this.prisma.stockItem.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(id: string): Promise<StockItemWithUnits> {
    const item = await this.prisma.stockItem.findUnique({
      where: { id },
      include: STOCK_ITEM_INCLUDE,
    });
    if (!item || item.deletedAt) {
      throw new NotFoundException('Stock item not found');
    }
    return item;
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateStockItemDto,
  ): Promise<StockItemWithUnits> {
    const existing = await this.findOne(id);

    if (dto.primaryUnitId && dto.primaryUnitId !== existing.primaryUnitId) {
      await this.assertUnitActive(dto.primaryUnitId, 'primary');
    }
    if (dto.secondaryUnitId !== undefined && dto.secondaryUnitId !== null) {
      await this.assertUnitActive(dto.secondaryUnitId, 'secondary');
    }

    // Final state used for the cross-field rule
    const finalSecondary =
      dto.secondaryUnitId === undefined
        ? existing.secondaryUnitId
        : dto.secondaryUnitId;
    const finalConversion =
      dto.conversionFactor === undefined
        ? existing.conversionFactor === null
          ? null
          : Number(existing.conversionFactor)
        : dto.conversionFactor;
    this.assertConversionFactorRule(finalSecondary, finalConversion);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.stockItem.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.primaryUnitId !== undefined
            ? { primaryUnitId: dto.primaryUnitId }
            : {}),
          ...(dto.secondaryUnitId !== undefined
            ? { secondaryUnitId: dto.secondaryUnitId }
            : {}),
          ...(dto.conversionFactor !== undefined
            ? { conversionFactor: dto.conversionFactor }
            : {}),
          ...(dto.consumptionStrategy !== undefined
            ? { consumptionStrategy: dto.consumptionStrategy }
            : {}),
          ...(dto.isSellable !== undefined
            ? { isSellable: dto.isSellable }
            : {}),
          ...(dto.trackLot !== undefined ? { trackLot: dto.trackLot } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        include: STOCK_ITEM_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'StockItem',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: { sku: updated.sku, fields: Object.keys(dto) },
      });

      return updated;
    });
  }

  // ───────────────────────── soft delete ─────────────────────────
  async remove(
    user: AuthenticatedUser,
    id: string,
  ): Promise<StockItemWithUnits> {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.stockItem.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
        include: STOCK_ITEM_INCLUDE,
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'StockItem',
        entityId: updated.id,
        action: AuditAction.DELETE,
        payload: { sku: updated.sku, softDelete: true },
      });
      return updated;
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private async assertSkuAvailable(sku: string): Promise<void> {
    const existing = await this.prisma.stockItem.findUnique({
      where: { sku },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException('SKU is already used');
    }
    // Soft-deleted SKU collisions are caught by the DB unique constraint as
    // a defensive backstop; surfacing it here as a conflict is more friendly.
    if (existing && existing.deletedAt) {
      throw new ConflictException(
        'SKU was used by a soft-deleted item; pick a new SKU',
      );
    }
  }

  private async assertUnitsValid(
    primaryUnitId: string,
    secondaryUnitId: string | undefined,
  ): Promise<void> {
    await this.assertUnitActive(primaryUnitId, 'primary');
    if (secondaryUnitId) {
      if (secondaryUnitId === primaryUnitId) {
        throw new BadRequestException(
          'secondaryUnit must differ from primaryUnit',
        );
      }
      await this.assertUnitActive(secondaryUnitId, 'secondary');
    }
  }

  private async assertUnitActive(
    unitId: string,
    label: 'primary' | 'secondary',
  ): Promise<void> {
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitId },
      select: { id: true, isActive: true },
    });
    if (!unit) {
      throw new NotFoundException(`${label} unit not found`);
    }
    if (!unit.isActive) {
      throw new BadRequestException(`${label} unit is inactive`);
    }
  }

  private assertConversionFactorRule(
    secondaryUnitId: string | null | undefined,
    conversionFactor: number | null | undefined,
  ): void {
    const hasSecondary = !!secondaryUnitId;
    const hasFactor =
      conversionFactor !== null && conversionFactor !== undefined;

    if (hasSecondary && !hasFactor) {
      throw new BadRequestException(
        'conversionFactor is required when secondaryUnit is set',
      );
    }
    if (!hasSecondary && hasFactor) {
      throw new BadRequestException(
        'conversionFactor must not be set when secondaryUnit is null',
      );
    }
  }
}

// Suppress unused-symbol warning for the type kept for consumers.
export type { StockItem };
