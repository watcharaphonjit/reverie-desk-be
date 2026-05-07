import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, Unit } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitQueryDto } from './dto/unit-query.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(user: AuthenticatedUser, dto: CreateUnitDto): Promise<Unit> {
    await this.assertCodeAvailable(dto.code);
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.unit.create({
        data: {
          code: dto.code,
          label: dto.label,
          isActive: dto.isActive ?? true,
        },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'Unit',
        entityId: unit.id,
        action: AuditAction.CREATE,
        payload: { code: unit.code, label: unit.label, isActive: unit.isActive },
      });
      return unit;
    });
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(query: UnitQueryDto): Promise<PaginatedResult<Unit>> {
    const where: Prisma.UnitWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { label: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.unit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { code: 'asc' },
      }),
      this.prisma.unit.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(id: string): Promise<Unit> {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateUnitDto,
  ): Promise<Unit> {
    const existing = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.unit.update({ where: { id }, data: dto });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'Unit',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: this.diff(existing, updated),
      });
      return updated;
    });
  }

  // ───────────────────────── soft disable ─────────────────────────
  async remove(user: AuthenticatedUser, id: string): Promise<Unit> {
    const existing = await this.findOne(id);
    if (!existing.isActive) {
      throw new BadRequestException('Unit is already inactive');
    }

    const refCount = await this.countLiveStockItemRefs(id);
    if (refCount > 0) {
      throw new ConflictException(
        `Unit is referenced by ${refCount} active stock item(s); reassign them first`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.unit.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'Unit',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: { field: 'isActive', from: true, to: false, softDisabled: true },
      });
      return updated;
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  /**
   * Counts non-deleted stock items that reference this unit either as primary
   * or secondary. Prefer Prisma's denormalised `count` for stable performance
   * over Promise-zipping two list fetches.
   */
  private async countLiveStockItemRefs(unitId: string): Promise<number> {
    return this.prisma.stockItem.count({
      where: {
        deletedAt: null,
        OR: [{ primaryUnitId: unitId }, { secondaryUnitId: unitId }],
      },
    });
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.prisma.unit.findUnique({ where: { code } });
    if (existing) throw new ConflictException('Unit code is already used');
  }

  private diff(before: Unit, after: Unit): Prisma.InputJsonValue {
    const out: Record<string, Prisma.InputJsonValue> = {};
    const fields: (keyof Unit)[] = ['label', 'isActive'];
    for (const f of fields) {
      if (before[f] !== after[f]) {
        out[f] = {
          from: (before[f] ?? null) as string | boolean | null,
          to: (after[f] ?? null) as string | boolean | null,
        };
      }
    }
    return out;
  }
}
