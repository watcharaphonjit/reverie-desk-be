import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  CommissionRule,
  CommissionType,
  CommissionValueType,
  Prisma,
  ServiceGroupCode,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalculateCommissionDto } from './dto/calculate-commission.dto';
import {
  BulkUpsertCommissionRulesDto,
  CommissionTierDto,
} from './dto/bulk-upsert-commission-rules.dto';
import { CreateCommissionRuleDto } from './dto/create-commission-rule.dto';
import { UpdateCommissionRuleDto } from './dto/update-commission-rule.dto';
import { CommissionRuleQueryDto } from './dto/commission-rule-query.dto';

/** Shape returned by the calculate endpoint, one entry per group. */
export interface CommissionCalculationLine {
  serviceGroupCode: ServiceGroupCode;
  groupSubtotal: number;
  matchedRuleId: string | null;
  matchedTier: {
    minimum: number;
    rate: number;
    type: CommissionValueType;
  } | null;
  computedCommission: number;
  /** Service items that contributed to this group's subtotal. */
  itemRefs: string[];
}

export interface CommissionCalculationResult {
  salesOrderId: string;
  branchId: string;
  totalCommission: number;
  lines: CommissionCalculationLine[];
  /** Items skipped because their service had no `commissionGroupCode`. */
  ungroupedItemRefs: string[];
}

const RULE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.CommissionRuleInclude;

type RuleWithRelations = Prisma.CommissionRuleGetPayload<{
  include: typeof RULE_INCLUDE;
}>;

@Injectable()
export class CommissionRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── LIST ───────────────────────────
  async findAll(
    query: CommissionRuleQueryDto,
  ): Promise<PaginatedResult<RuleWithRelations>> {
    const where: Prisma.CommissionRuleWhereInput = {
      // Tier rows always have a serviceGroupCode set; non-tier legacy rows
      // (role-scoped, no group) leak through unless we filter explicitly.
      // The list endpoint is intended for the tier UI, so we restrict to
      // rows that are actually tier rules.
      serviceGroupCode: query.serviceGroupCode
        ? query.serviceGroupCode
        : { not: null },
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.commissionType ? { commissionType: query.commissionType } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.commissionRule.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        // Group bundles read top-down from highest tier to lowest within
        // each (branch, group) cluster.
        orderBy: [
          { branchId: 'asc' },
          { serviceGroupCode: 'asc' },
          { minAmount: 'asc' },
        ],
        include: RULE_INCLUDE,
      }),
      this.prisma.commissionRule.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── BULK UPSERT ─────────────────────────
  /**
   * Atomically replace the tier ladder for every (branch, group) bundle in
   * the request. For each bundle:
   *   1. Validate the tiers (unique/ascending minimums, percentage ≤ 1).
   *   2. Soft-purge: deactivate every existing tier for this (branch, group,
   *      commissionType). We deactivate rather than hard-delete so existing
   *      `CommissionSnapshot` rows can keep their FK reference for audit.
   *   3. Insert the new tier rows as `isActive = true`.
   * If any bundle fails validation, no writes happen (single $transaction).
   */
  async bulkUpsert(
    user: AuthenticatedUser,
    dto: BulkUpsertCommissionRulesDto,
  ): Promise<{
    bundlesUpdated: number;
    tiersWritten: number;
    rules: RuleWithRelations[];
  }> {
    // Pre-flight validation so we fail before opening the tx.
    for (const [idx, bundle] of dto.bundles.entries()) {
      assertTiersValid(bundle.tiers, idx);
    }
    // Cross-bundle: same (branchId, group, commissionType) twice is invalid
    // (would be a self-overwrite within one request). Reject loudly.
    const seen = new Set<string>();
    for (const [idx, bundle] of dto.bundles.entries()) {
      const key = `${bundle.branchId}|${bundle.serviceGroupCode}|${bundle.commissionType ?? 'SALES_COMMISSION'}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `bundles[${idx}]: duplicate (branchId, serviceGroupCode, commissionType) within request`,
        );
      }
      seen.add(key);
    }

    // Validate referenced branches exist and are ACTIVE.
    const branchIds = Array.from(new Set(dto.bundles.map((b) => b.branchId)));
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true, status: true, code: true },
    });
    const branchMap = new Map(branches.map((b) => [b.id, b]));
    for (const [idx, bundle] of dto.bundles.entries()) {
      const branch = branchMap.get(bundle.branchId);
      if (!branch) {
        throw new BadRequestException(
          `bundles[${idx}]: branchId ${bundle.branchId} does not exist`,
        );
      }
      if (branch.status !== 'ACTIVE') {
        throw new BadRequestException(
          `bundles[${idx}]: branch ${branch.code} is not ACTIVE`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const writtenRuleIds: string[] = [];
      let totalTiers = 0;

      for (const bundle of dto.bundles) {
        const commissionType: CommissionType =
          bundle.commissionType ?? CommissionType.SALES_COMMISSION;

        const existing = await tx.commissionRule.findMany({
          where: {
            branchId: bundle.branchId,
            serviceGroupCode: bundle.serviceGroupCode,
            commissionType,
            isActive: true,
          },
          select: { id: true },
        });
        if (existing.length > 0) {
          await tx.commissionRule.updateMany({
            where: { id: { in: existing.map((r) => r.id) } },
            data: { isActive: false },
          });
        }

        for (const tier of bundle.tiers) {
          const created = await tx.commissionRule.create({
            data: {
              roleId: null,
              branchId: bundle.branchId,
              serviceGroupCode: bundle.serviceGroupCode,
              commissionType,
              valueType: tier.type,
              value: new Prisma.Decimal(tier.rate),
              minAmount: new Prisma.Decimal(tier.minimum),
              maxAmount: null,
              startsAt: new Date(),
              endsAt: null,
              isActive: true,
            },
          });
          writtenRuleIds.push(created.id);
          totalTiers += 1;
        }

        await this.audit.recordWith(tx, {
          actorUserId: user.id,
          branchId: bundle.branchId,
          entityType: 'CommissionRule',
          entityId: bundle.branchId,
          action: AuditAction.UPDATE,
          payload: {
            op: 'bulk-upsert',
            branchId: bundle.branchId,
            serviceGroupCode: bundle.serviceGroupCode,
            commissionType,
            replacedTiers: existing.length,
            newTiers: bundle.tiers.length,
            // Map class instances to plain JSON-compatible objects so the
            // payload satisfies `Prisma.InputJsonValue`.
            tiers: bundle.tiers.map((t) => ({
              minimum: t.minimum,
              rate: t.rate,
              type: t.type,
            })),
          },
        });
      }

      const rules = await tx.commissionRule.findMany({
        where: { id: { in: writtenRuleIds } },
        include: RULE_INCLUDE,
        orderBy: [
          { branchId: 'asc' },
          { serviceGroupCode: 'asc' },
          { minAmount: 'asc' },
        ],
      });
      return {
        bundlesUpdated: dto.bundles.length,
        tiersWritten: totalTiers,
        rules,
      };
    });
  }

  // ───────────────────────── SINGLE-RULE CRUD ─────────────────────────
  /**
   * Create a single tier row. Unlike `bulkUpsert`, this does NOT touch any
   * existing tiers in the (branch, group, commissionType) ladder — callers
   * use this when adding one tier on top of an existing ladder. Conflicts
   * are explicit:
   *   - duplicate active `minAmount` for the same (branch, group, type) → 409
   *   - PERCENTAGE rate > 1 → 400
   * Branches are validated for existence + ACTIVE status.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateCommissionRuleDto,
  ): Promise<RuleWithRelations> {
    if (dto.valueType === CommissionValueType.PERCENTAGE && dto.value > 1) {
      throw new BadRequestException('PERCENTAGE value must be ≤ 1 (e.g. 0.05)');
    }
    if (dto.value < 0) {
      throw new BadRequestException('value must be ≥ 0');
    }
    if (dto.minimumAmount < 0) {
      throw new BadRequestException('minimumAmount must be ≥ 0');
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true, status: true, code: true },
    });
    if (!branch) {
      throw new BadRequestException(`branchId ${dto.branchId} does not exist`);
    }
    if (branch.status !== 'ACTIVE') {
      throw new BadRequestException(`branch ${branch.code} is not ACTIVE`);
    }

    const commissionType: CommissionType =
      dto.commissionType ?? CommissionType.SALES_COMMISSION;

    return this.prisma.$transaction(async (tx) => {
      const conflict = await tx.commissionRule.findFirst({
        where: {
          branchId: dto.branchId,
          serviceGroupCode: dto.commissionGroup,
          commissionType,
          minAmount: new Prisma.Decimal(dto.minimumAmount),
          isActive: true,
        },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException(
          `An active tier at minimum=${dto.minimumAmount} already exists for this (branch, group, type) — use PATCH to modify it`,
        );
      }

      const created = await tx.commissionRule.create({
        data: {
          roleId: dto.roleId ?? null,
          branchId: dto.branchId,
          serviceGroupCode: dto.commissionGroup,
          commissionType,
          valueType: dto.valueType,
          value: new Prisma.Decimal(dto.value),
          minAmount: new Prisma.Decimal(dto.minimumAmount),
          maxAmount: null,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : new Date(),
          endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
          isActive: true,
        },
        include: RULE_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: dto.branchId,
        entityType: 'CommissionRule',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          op: 'create',
          serviceGroupCode: dto.commissionGroup,
          commissionType,
          minimumAmount: dto.minimumAmount,
          valueType: dto.valueType,
          value: dto.value,
        },
      });
      return created;
    });
  }

  /**
   * Patch a single rule. Only mutable fields are accepted; identity fields
   * (branchId, commissionType, serviceGroupCode) cannot be moved — use
   * DELETE + create-new instead so the audit trail is unambiguous.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateCommissionRuleDto,
  ): Promise<RuleWithRelations> {
    const existing = await this.prisma.commissionRule.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Commission rule not found');

    if (dto.valueType !== undefined && dto.value === undefined) {
      throw new BadRequestException(
        'When changing valueType you must also supply value (mismatched rates can break the ladder)',
      );
    }
    if (
      dto.valueType === CommissionValueType.PERCENTAGE &&
      dto.value !== undefined &&
      dto.value > 1
    ) {
      throw new BadRequestException('PERCENTAGE value must be ≤ 1');
    }
    if (dto.value !== undefined && dto.value < 0) {
      throw new BadRequestException('value must be ≥ 0');
    }
    if (dto.minimumAmount !== undefined && dto.minimumAmount < 0) {
      throw new BadRequestException('minimumAmount must be ≥ 0');
    }

    // Avoid creating duplicate (branch, group, type, minAmount) actives.
    if (dto.minimumAmount !== undefined && existing.isActive) {
      const conflict = await this.prisma.commissionRule.findFirst({
        where: {
          id: { not: id },
          branchId: existing.branchId,
          serviceGroupCode: existing.serviceGroupCode,
          commissionType: existing.commissionType,
          minAmount: new Prisma.Decimal(dto.minimumAmount),
          isActive: true,
        },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException(
          `Another active tier at minimum=${dto.minimumAmount} exists for this (branch, group, type)`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.commissionRule.update({
        where: { id },
        data: {
          ...(dto.value !== undefined
            ? { value: new Prisma.Decimal(dto.value) }
            : {}),
          ...(dto.valueType !== undefined ? { valueType: dto.valueType } : {}),
          ...(dto.minimumAmount !== undefined
            ? { minAmount: new Prisma.Decimal(dto.minimumAmount) }
            : {}),
          ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
          ...(dto.startsAt !== undefined
            ? { startsAt: new Date(dto.startsAt) }
            : {}),
          ...(dto.endsAt !== undefined
            ? { endsAt: dto.endsAt === null ? null : new Date(dto.endsAt) }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        include: RULE_INCLUDE,
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: existing.branchId ?? null,
        entityType: 'CommissionRule',
        entityId: id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'update',
          // Spread into a plain object so it satisfies Prisma.InputJsonValue.
          changes: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /**
   * Soft-delete by flipping `isActive=false`. The row stays so existing
   * `CommissionSnapshot.commissionRuleId` references stay resolvable for
   * audit/history. A subsequent POST can re-introduce the same minimum
   * with a different value if needed — the unique-conflict check excludes
   * inactive rows.
   */
  async softDelete(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ id: string; isActive: false }> {
    const existing = await this.prisma.commissionRule.findUnique({
      where: { id },
      select: { id: true, isActive: true, branchId: true },
    });
    if (!existing) throw new NotFoundException('Commission rule not found');
    if (!existing.isActive) {
      // Idempotent — silently succeed if already inactive.
      return { id, isActive: false };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.commissionRule.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: existing.branchId ?? null,
        entityType: 'CommissionRule',
        entityId: id,
        action: AuditAction.DELETE,
        payload: { op: 'soft-delete' },
      });
    });
    return { id, isActive: false };
  }

  // ───────────────────────── CALCULATE ─────────────────────────
  /**
   * Compute commission for an existing sales order without persisting any
   * records. Splits items by `service.commissionGroupCode`, picks the
   * winning tier for each group's subtotal, and totals them up.
   */
  async calculateForOrder(
    user: AuthenticatedUser,
    dto: CalculateCommissionDto,
  ): Promise<CommissionCalculationResult> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: dto.salesOrderId },
      include: {
        items: {
          include: {
            service: { select: { commissionGroupCode: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');

    // Bucket items by group, summing their netAmount.
    const groupBuckets = new Map<
      ServiceGroupCode,
      { subtotal: number; itemRefs: string[] }
    >();
    const ungroupedItemRefs: string[] = [];

    for (const item of order.items) {
      const groupCode = item.service.commissionGroupCode;
      const net = decToNum(item.netAmount);
      if (!groupCode) {
        ungroupedItemRefs.push(item.id);
        continue;
      }
      const bucket = groupBuckets.get(groupCode);
      if (bucket) {
        bucket.subtotal = round2(bucket.subtotal + net);
        bucket.itemRefs.push(item.id);
      } else {
        groupBuckets.set(groupCode, {
          subtotal: round2(net),
          itemRefs: [item.id],
        });
      }
    }

    // Look up tier rules for each group present.
    const groups = Array.from(groupBuckets.keys());
    const rules =
      groups.length === 0
        ? []
        : await this.prisma.commissionRule.findMany({
            where: {
              branchId: order.branchId,
              serviceGroupCode: { in: groups },
              commissionType: CommissionType.SALES_COMMISSION,
              isActive: true,
            },
            orderBy: { minAmount: 'asc' },
          });

    // Group rules by serviceGroupCode for quick lookup.
    const rulesByGroup = new Map<ServiceGroupCode, CommissionRule[]>();
    for (const rule of rules) {
      if (!rule.serviceGroupCode) continue;
      const arr = rulesByGroup.get(rule.serviceGroupCode) ?? [];
      arr.push(rule);
      rulesByGroup.set(rule.serviceGroupCode, arr);
    }

    const lines: CommissionCalculationLine[] = [];
    let totalCommission = 0;

    for (const [group, bucket] of groupBuckets) {
      const groupRules = rulesByGroup.get(group) ?? [];
      const matched = pickHighestMatchingTier(groupRules, bucket.subtotal);
      let computed = 0;
      if (matched) {
        const rate = decToNum(matched.value);
        computed =
          matched.valueType === CommissionValueType.FIXED
            ? round2(rate)
            : round2(bucket.subtotal * rate);
      }
      totalCommission = round2(totalCommission + computed);
      lines.push({
        serviceGroupCode: group,
        groupSubtotal: bucket.subtotal,
        matchedRuleId: matched?.id ?? null,
        matchedTier: matched
          ? {
              minimum: decToNum(matched.minAmount),
              rate: decToNum(matched.value),
              type: matched.valueType,
            }
          : null,
        computedCommission: computed,
        itemRefs: bucket.itemRefs,
      });
    }

    void user; // for future authz hooks
    return {
      salesOrderId: order.id,
      branchId: order.branchId,
      totalCommission,
      lines,
      ungroupedItemRefs,
    };
  }
}

// ─────────────────── module-private utils ───────────────────

/**
 * Validate a single bundle's tier list against the spec's rules:
 *   - minimums ≥ 0, unique, ascending
 *   - rate ≥ 0
 *   - PERCENTAGE rate ≤ 1
 */
function assertTiersValid(tiers: CommissionTierDto[], bundleIdx: number): void {
  const minimums = new Set<number>();
  let prevMin = -Infinity;
  for (const [tierIdx, tier] of tiers.entries()) {
    const path = `bundles[${bundleIdx}].tiers[${tierIdx}]`;
    if (tier.rate < 0) {
      throw new BadRequestException(`${path}: rate must be ≥ 0`);
    }
    if (tier.type === CommissionValueType.PERCENTAGE && tier.rate > 1) {
      throw new BadRequestException(
        `${path}: PERCENTAGE rate must be ≤ 1 (got ${tier.rate})`,
      );
    }
    if (minimums.has(tier.minimum)) {
      throw new BadRequestException(
        `${path}: duplicate minimum threshold ${tier.minimum}`,
      );
    }
    if (tier.minimum <= prevMin) {
      throw new BadRequestException(
        `${path}: minimum thresholds must be strictly ascending (got ${tier.minimum} after ${prevMin})`,
      );
    }
    minimums.add(tier.minimum);
    prevMin = tier.minimum;
  }
}

/**
 * Spec selection rule: "Choose highest matching minimum where
 * orderAmount >= minimum". `rules` may arrive unordered — we don't assume.
 */
export function pickHighestMatchingTier(
  rules: CommissionRule[],
  orderAmount: number,
): CommissionRule | null {
  let best: CommissionRule | null = null;
  let bestMin = -Infinity;
  for (const rule of rules) {
    if (rule.minAmount == null) continue;
    const min = decToNum(rule.minAmount);
    if (orderAmount >= min && min > bestMin) {
      best = rule;
      bestMin = min;
    }
  }
  return best;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};
