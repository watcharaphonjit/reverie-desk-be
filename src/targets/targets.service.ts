import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, ServiceGroupCode } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertBranchAccess } from '../common/authz/branch-scope';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateQuarterTargetDto,
  QuarterTargetCategoryDto,
} from './dto/create-quarter-target.dto';
import { UpdateQuarterTargetDto } from './dto/update-quarter-target.dto';
import { assertCategorySumMatchesTotal } from './quarter.util';

const TARGET_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
  categories: {
    orderBy: { commissionGroup: 'asc' },
    select: {
      id: true,
      commissionGroup: true,
      targetAmount: true,
    },
  },
} satisfies Prisma.BranchQuarterTargetInclude;

export type TargetWithRelations = Prisma.BranchQuarterTargetGetPayload<{
  include: typeof TARGET_INCLUDE;
}>;

@Injectable()
export class TargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────── Reads ──────────────────────

  /** GET /targets/branch/:branchId?year&quarter — returns 404 if no row exists. */
  async findForQuarter(
    user: AuthenticatedUser,
    branchId: string,
    year: number,
    quarter: number,
  ): Promise<TargetWithRelations> {
    assertBranchAccess(user, branchId);
    const target = await this.prisma.branchQuarterTarget.findUnique({
      where: { branchId_year_quarter: { branchId, year, quarter } },
      include: TARGET_INCLUDE,
    });
    if (!target) {
      throw new NotFoundException(
        `No target set for branch ${branchId} ${year}-Q${quarter}`,
      );
    }
    return target;
  }

  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<TargetWithRelations> {
    const target = await this.prisma.branchQuarterTarget.findUnique({
      where: { id },
      include: TARGET_INCLUDE,
    });
    if (!target) throw new NotFoundException('Target not found');
    assertBranchAccess(user, target.branchId);
    return target;
  }

  // ────────────────────── Create ──────────────────────

  async create(
    user: AuthenticatedUser,
    dto: CreateQuarterTargetDto,
  ): Promise<TargetWithRelations> {
    assertBranchAccess(user, dto.branchId);
    assertCategoriesUnique(dto.categories);
    try {
      assertCategorySumMatchesTotal(
        dto.totalTarget,
        dto.categories.map((c) => c.targetAmount),
      );
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }

    // Verify the branch exists + is active. We cascade on delete, but a
    // user-friendly 404 is much better than a Prisma FK-violation 500.
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true, status: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    if (branch.status !== 'ACTIVE') {
      throw new BadRequestException('Cannot set targets on an inactive branch');
    }

    return this.prisma.$transaction(async (tx) => {
      let created: TargetWithRelations;
      try {
        created = await tx.branchQuarterTarget.create({
          data: {
            branchId: dto.branchId,
            year: dto.year,
            quarter: dto.quarter,
            totalTarget: new Prisma.Decimal(dto.totalTarget),
            createdByUserId: user.id,
            categories: {
              create: dto.categories.map((c) => ({
                commissionGroup: c.commissionGroup,
                targetAmount: new Prisma.Decimal(c.targetAmount),
              })),
            },
          },
          include: TARGET_INCLUDE,
        });
      } catch (err) {
        // P2002 = unique-constraint violation. The DB-level
        // `(branchId, year, quarter)` uniqueness is what enforces the
        // "duplicate target" success-criterion; surface as 409 so the
        // FE can show "already configured" without re-prompting.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictException(
            `Target for branch ${dto.branchId} ${dto.year}-Q${dto.quarter} already exists`,
          );
        }
        throw err;
      }

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: created.branchId,
        entityType: 'BranchQuarterTarget',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          op: 'create',
          year: created.year,
          quarter: created.quarter,
          totalTarget: created.totalTarget.toString(),
          categories: created.categories.map((c) => ({
            commissionGroup: c.commissionGroup,
            targetAmount: c.targetAmount.toString(),
          })),
        },
      });

      return created;
    });
  }

  // ────────────────────── Update ──────────────────────

  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateQuarterTargetDto,
  ): Promise<TargetWithRelations> {
    if (dto.totalTarget === undefined && dto.categories === undefined) {
      throw new BadRequestException(
        'Update body must include at least one of: totalTarget, categories',
      );
    }

    const existing = await this.findOne(user, id); // also asserts branch access + 404

    if (dto.categories) assertCategoriesUnique(dto.categories);

    // Resolve the post-update {total, categories} pair, then validate
    // they agree. The matrix lives here once so the three branches
    // ({total only, categories only, both}) are obvious.
    const newTotal =
      dto.totalTarget !== undefined
        ? dto.totalTarget
        : Number(existing.totalTarget.toString());
    const newCategoryAmounts: Array<{
      commissionGroup: ServiceGroupCode;
      targetAmount: number;
    }> = dto.categories
      ? dto.categories.map((c) => ({
          commissionGroup: c.commissionGroup,
          targetAmount: c.targetAmount,
        }))
      : existing.categories.map((c) => ({
          commissionGroup: c.commissionGroup,
          targetAmount: Number(c.targetAmount.toString()),
        }));

    try {
      assertCategorySumMatchesTotal(
        newTotal,
        newCategoryAmounts.map((c) => c.targetAmount),
      );
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Atomic replace: drop existing categories then re-create. The
      // unique `(targetId, commissionGroup)` constraint means we can't
      // upsert in place if the new set has a different membership, so
      // we always go through the drop+create path when categories are
      // supplied.
      if (dto.categories) {
        await tx.branchQuarterTargetCategory.deleteMany({
          where: { targetId: id },
        });
        await tx.branchQuarterTargetCategory.createMany({
          data: dto.categories.map((c) => ({
            targetId: id,
            commissionGroup: c.commissionGroup,
            targetAmount: new Prisma.Decimal(c.targetAmount),
          })),
        });
      }

      const updated = await tx.branchQuarterTarget.update({
        where: { id },
        data: {
          ...(dto.totalTarget !== undefined
            ? { totalTarget: new Prisma.Decimal(dto.totalTarget) }
            : {}),
        },
        include: TARGET_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'BranchQuarterTarget',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'update',
          ...(dto.totalTarget !== undefined
            ? {
                totalTarget: {
                  from: existing.totalTarget.toString(),
                  to: updated.totalTarget.toString(),
                },
              }
            : {}),
          ...(dto.categories
            ? { categoriesReplaced: updated.categories.length }
            : {}),
        },
      });

      return updated;
    });
  }
}

/**
 * Reject category arrays containing the same `commissionGroup` more
 * than once. Surfaces as a clean 400 instead of a Prisma P2002 from
 * the unique constraint deeper down.
 */
function assertCategoriesUnique(categories: QuarterTargetCategoryDto[]): void {
  const seen = new Set<ServiceGroupCode>();
  for (const c of categories) {
    if (seen.has(c.commissionGroup)) {
      throw new BadRequestException(
        `Duplicate commissionGroup ${c.commissionGroup} in categories`,
      );
    }
    seen.add(c.commissionGroup);
  }
}
