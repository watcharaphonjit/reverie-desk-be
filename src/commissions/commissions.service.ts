import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Commission,
  CommissionRule,
  CommissionSnapshot,
  CommissionStatus,
  CommissionType,
  CommissionValueType,
  NotificationType,
  Prisma,
  ServiceGroupCode,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  scopedBranchFilter,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { pickHighestMatchingTier } from './commission-rules.service';
import {
  CommissionPeriodField,
  CommissionQueryDto,
} from './dto/commission-query.dto';

const COMMISSION_INCLUDE = {
  snapshot: true,
  recipientUser: { select: { id: true, fullName: true, email: true } },
  createdByUser: { select: { id: true, fullName: true, email: true } },
  salesOrder: {
    select: { id: true, orderNo: true, branchId: true, status: true },
  },
} satisfies Prisma.CommissionInclude;

type CommissionWithRelations = Prisma.CommissionGetPayload<{
  include: typeof COMMISSION_INCLUDE;
}>;

export interface EvaluateOrderResult {
  salesOrderId: string;
  createdCount: number;
  skippedExistingCount: number;
  ineligibleGroups: Array<{
    group: ServiceGroupCode;
    type: CommissionType;
    reason: string;
  }>;
  commissions: CommissionWithRelations[];
}

export interface CommissionBatchActionItemResult {
  id: string;
  success: boolean;
  commission?: CommissionWithRelations;
  error?: string;
}

export interface CommissionBatchActionResult {
  requestedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  results: CommissionBatchActionItemResult[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};

const COMMISSION_PERIOD_COLUMN: Record<
  CommissionPeriodField,
  keyof Prisma.CommissionWhereInput
> = {
  CREATED_AT: 'createdAt',
  ELIGIBLE_AT: 'eligibleAt',
  LOCKED_AT: 'lockedAt',
  PAID_AT: 'paidAt',
};

/**
 * Commission engine.
 *
 * Lifecycle: PENDING → ELIGIBLE → LOCKED → PAID, with REVOKED reachable
 * from any pre-PAID state (refund completion calls into here). The engine
 * only creates commissions whose eligibility checks pass *now*; rows are
 * never written in PENDING state, because we already gate the trigger
 * point on `depositSatisfiedAt`. PENDING remains a valid status only
 * because the schema permits it for forward-compat / manual entry.
 *
 * `evaluateOrder()` is idempotent: it dedupes by
 * (salesOrderId, commissionType, serviceGroupCode) so it can be called
 * multiple times (e.g. on each successful deposit-tier payment) without
 * producing duplicate commissions.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────── public entry: evaluate ─────────────────────────

  async evaluateOrder(
    user: AuthenticatedUser,
    salesOrderId: string,
  ): Promise<EvaluateOrderResult> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { branchId: true },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    assertBranchAccess(user, order.branchId);
    return this.prisma.$transaction((tx) =>
      this.evaluateOrderWith(tx, salesOrderId, user.id),
    );
  }

  /**
   * Same logic as {@link evaluateOrder} but re-uses the caller's transaction.
   * Used by payments.service when stamping `depositSatisfiedAt`.
   */
  async evaluateOrderWith(
    tx: Prisma.TransactionClient,
    salesOrderId: string,
    actorUserId: string | null,
  ): Promise<EvaluateOrderResult> {
    const order = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        branch: { select: { id: true, name: true } },
        items: {
          include: {
            service: {
              select: {
                id: true,
                name: true,
                commissionGroupCode: true,
              },
            },
          },
        },
        createdBy: { select: { id: true, fullName: true } },
        lead: {
          select: {
            id: true,
            currentOwnerUserId: true,
            currentOwner: {
              select: {
                id: true,
                fullName: true,
                userRoles: {
                  select: { role: { select: { code: true } } },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');

    // Bucket items by group, capturing both subtotal and a service name to
    // freeze on the snapshot row (use the first item's service name as a
    // reasonable label — group-level snapshots span multiple items).
    const groupBuckets = new Map<
      ServiceGroupCode,
      { subtotal: number; serviceName: string; itemRefs: string[] }
    >();
    for (const item of order.items) {
      const code = item.service.commissionGroupCode;
      if (!code) continue;
      const bucket = groupBuckets.get(code);
      if (bucket) {
        bucket.subtotal = round2(bucket.subtotal + decToNum(item.netAmount));
        bucket.itemRefs.push(item.id);
      } else {
        groupBuckets.set(code, {
          subtotal: round2(decToNum(item.netAmount)),
          serviceName: item.service.name,
          itemRefs: [item.id],
        });
      }
    }
    const groups = Array.from(groupBuckets.keys());

    // Eligibility flags shared across all snapshots for this order.
    const depositPaid = order.depositSatisfiedAt != null;
    const [appointmentCount, eventCount] = await Promise.all([
      tx.appointment.count({ where: { salesOrderId: order.id } }),
      tx.customerServiceEvent.count({ where: { salesOrderId: order.id } }),
    ]);
    const appointmentBookedOrEvent = appointmentCount > 0 || eventCount > 0;

    // Existing snapshots for dedupe: (group, type).
    const existingSnapshots = await tx.commissionSnapshot.findMany({
      where: {
        salesOrderId: order.id,
        serviceGroupCode: { in: groups.length > 0 ? groups : undefined },
      },
      select: { serviceGroupCode: true, commissionType: true },
    });
    const existingKeys = new Set<string>(
      existingSnapshots.map(
        (s) => `${s.serviceGroupCode ?? 'NULL'}|${s.commissionType}`,
      ),
    );

    // Resolve all rules in one shot per type, then pick per-group/type.
    const types: CommissionType[] = [
      CommissionType.LEAD_REWARD,
      CommissionType.SALES_COMMISSION,
    ];
    const rules =
      groups.length === 0
        ? []
        : await tx.commissionRule.findMany({
            where: {
              branchId: order.branchId,
              serviceGroupCode: { in: groups },
              commissionType: { in: types },
              isActive: true,
            },
            orderBy: { minAmount: 'asc' },
          });
    const rulesByGroupType = new Map<string, CommissionRule[]>();
    for (const rule of rules) {
      if (!rule.serviceGroupCode) continue;
      const key = `${rule.serviceGroupCode}|${rule.commissionType}`;
      const arr = rulesByGroupType.get(key) ?? [];
      arr.push(rule);
      rulesByGroupType.set(key, arr);
    }

    const created: CommissionWithRelations[] = [];
    const ineligible: EvaluateOrderResult['ineligibleGroups'] = [];
    let skippedExisting = 0;

    for (const [group, bucket] of groupBuckets) {
      for (const type of types) {
        const dedupeKey = `${group}|${type}`;
        if (existingKeys.has(dedupeKey)) {
          skippedExisting += 1;
          continue;
        }
        const eligible = this.checkEligibility(type, {
          depositPaid,
          appointmentBookedOrEvent,
          hasLead: order.lead != null,
          hasLeadOwner: order.lead?.currentOwnerUserId != null,
        });
        if (!eligible.ok) {
          ineligible.push({
            group,
            type,
            reason: eligible.reason,
          });
          continue;
        }
        const recipientUserId =
          type === CommissionType.LEAD_REWARD
            ? order.lead?.currentOwnerUserId
            : order.createdByUserId;
        if (!recipientUserId) {
          // Defensive: eligibility passed but recipient missing (shouldn't
          // happen given the eligibility checks); skip rather than crash.
          ineligible.push({
            group,
            type,
            reason: 'No recipient user resolved',
          });
          continue;
        }

        const groupRules = rulesByGroupType.get(dedupeKey) ?? [];
        const matched = pickHighestMatchingTier(groupRules, bucket.subtotal);
        if (!matched) {
          ineligible.push({
            group,
            type,
            reason: `No tier matches subtotal ${bucket.subtotal}`,
          });
          continue;
        }

        const rate = decToNum(matched.value);
        const computed =
          matched.valueType === CommissionValueType.FIXED
            ? round2(rate)
            : round2(bucket.subtotal * rate);

        const now = new Date();
        const snapshot = await tx.commissionSnapshot.create({
          data: {
            salesOrderId: order.id,
            leadId: order.lead?.id ?? null,
            commissionRuleId: matched.id,
            leadOwnerUserId: order.lead?.currentOwnerUserId ?? null,
            saleCreatorUserId: order.createdByUserId,
            commissionType: type,
            serviceGroupCode: group,
            ruleValueType: matched.valueType,
            ruleValue: matched.value,
            groupSubtotal: new Prisma.Decimal(bucket.subtotal),
            computedAmount: new Prisma.Decimal(computed),
            eligibilityDepositPaid: depositPaid,
            eligibilityAppointmentBooked: appointmentBookedOrEvent,
            eligibleAt: now,
            snapshotLeadOwnerName: order.lead?.currentOwner?.fullName ?? null,
            snapshotSaleCreatorName: order.createdBy.fullName,
            snapshotRoleCode:
              order.lead?.currentOwner?.userRoles[0]?.role.code ?? null,
            snapshotServiceName: bucket.serviceName,
            snapshotBranchName: order.branch.name,
          },
        });

        const commission = await tx.commission.create({
          data: {
            snapshotId: snapshot.id,
            salesOrderId: order.id,
            recipientUserId,
            createdByUserId: actorUserId,
            type,
            status: CommissionStatus.ELIGIBLE,
            amount: new Prisma.Decimal(computed),
            currency: 'THB',
            eligibleAt: now,
          },
          include: COMMISSION_INCLUDE,
        });

        await this.audit.recordWith(tx, {
          actorUserId,
          branchId: order.branchId,
          entityType: 'Commission',
          entityId: commission.id,
          action: AuditAction.CREATE,
          payload: {
            op: 'evaluate',
            salesOrderId: order.id,
            commissionType: type,
            serviceGroupCode: group,
            groupSubtotal: bucket.subtotal,
            matchedRuleId: matched.id,
            tier: {
              minimum: decToNum(matched.minAmount),
              rate,
              type: matched.valueType,
            },
            computedAmount: computed,
            recipientUserId,
            snapshotId: snapshot.id,
          },
        });

        created.push(commission);
      }
    }

    return {
      salesOrderId: order.id,
      createdCount: created.length,
      skippedExistingCount: skippedExisting,
      ineligibleGroups: ineligible,
      commissions: created,
    };
  }

  // ───────────────────────── list / detail ─────────────────────────

  async findAll(
    user: AuthenticatedUser,
    query: CommissionQueryDto,
  ): Promise<PaginatedResult<CommissionWithRelations>> {
    if (query.branchId) {
      assertBranchAccess(user, query.branchId);
    }
    const branchScope = query.branchId ?? scopedBranchFilter(user);
    const where: Prisma.CommissionWhereInput = {
      ...(query.recipientUserId
        ? { recipientUserId: query.recipientUserId }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.salesOrderId ? { salesOrderId: query.salesOrderId } : {}),
      ...(branchScope ? { salesOrder: { branchId: branchScope } } : {}),
      ...(query.group ? { snapshot: { serviceGroupCode: query.group } } : {}),
      ...this.buildPeriodFilter(query),
    };
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const orderField =
      COMMISSION_PERIOD_COLUMN[query.periodField ?? 'CREATED_AT'];
    const orderBy: Prisma.CommissionOrderByWithRelationInput[] =
      orderField === 'createdAt'
        ? [{ createdAt: 'desc' }]
        : [
            {
              [orderField]: 'desc',
            },
            { createdAt: 'desc' },
          ];
    const [data, total] = await this.prisma.$transaction([
      this.prisma.commission.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: COMMISSION_INCLUDE,
      }),
      this.prisma.commission.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<CommissionWithRelations> {
    const commission = await this.prisma.commission.findUnique({
      where: { id },
      include: COMMISSION_INCLUDE,
    });
    if (!commission) throw new NotFoundException('Commission not found');
    assertBranchAccess(user, commission.salesOrder.branchId);
    return commission;
  }

  async lockBatch(
    user: AuthenticatedUser,
    ids: string[],
    note?: string | null,
  ): Promise<CommissionBatchActionResult> {
    return this.runBatch(ids, (id) => this.lock(user, id, note));
  }

  async payBatch(
    user: AuthenticatedUser,
    ids: string[],
    note?: string | null,
  ): Promise<CommissionBatchActionResult> {
    return this.runBatch(ids, (id) => this.pay(user, id, note));
  }

  /**
   * Post-commit fan-out: iterate every ELIGIBLE commission for the
   * given order and dispatch a notification to each recipient. Safe to
   * call repeatedly — dedupe keys make the second call a no-op.
   *
   * Used by the payments hook after a deposit-satisfied commit so
   * recipients see the alert near-real-time without waiting for the
   * hourly `COMMISSION_ELIGIBLE` cron sweep.
   */
  async notifyEligibleForOrder(salesOrderId: string): Promise<number> {
    const commissions = await this.prisma.commission.findMany({
      where: { salesOrderId, status: CommissionStatus.ELIGIBLE },
      select: {
        id: true,
        amount: true,
        recipientUserId: true,
        type: true,
        salesOrder: { select: { orderNo: true, branchId: true } },
      },
    });
    let created = 0;
    for (const c of commissions) {
      const result = await this.notifications.notify({
        userId: c.recipientUserId,
        branchId: c.salesOrder.branchId,
        title: `Commission eligible: ${decToNum(c.amount)}`,
        message: `Your ${c.type.replaceAll('_', ' ').toLowerCase()} commission of ${decToNum(c.amount)} on order ${c.salesOrder.orderNo} is eligible.`,
        type: NotificationType.COMMISSION_ELIGIBLE,
        metadata: {
          commissionId: c.id,
          salesOrderId,
        },
        dedupeKey: `COMMISSION_ELIGIBLE|${c.id}|${c.recipientUserId}`,
      });
      if (result.created) created++;
    }
    return created;
  }

  // ───────────────────────── transitions ─────────────────────────

  async lock(
    user: AuthenticatedUser,
    id: string,
    note?: string | null,
  ): Promise<CommissionWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findUnique({
        where: { id },
        include: { salesOrder: { select: { branchId: true } } },
      });
      if (!commission) throw new NotFoundException('Commission not found');
      assertBranchAccess(user, commission.salesOrder.branchId);
      if (commission.status !== CommissionStatus.ELIGIBLE) {
        throw new ConflictException(
          `Cannot lock commission in status ${commission.status} (must be ELIGIBLE)`,
        );
      }
      const now = new Date();
      const updated = await tx.commission.update({
        where: { id },
        data: {
          status: CommissionStatus.LOCKED,
          lockedAt: now,
          ...(note ? { note } : {}),
        },
        include: COMMISSION_INCLUDE,
      });
      await tx.commissionSnapshot.update({
        where: { id: commission.snapshotId },
        data: { lockedAt: now, ...(note ? { lockReason: note } : {}) },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: commission.salesOrder.branchId,
        entityType: 'Commission',
        entityId: commission.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'lock',
          from: CommissionStatus.ELIGIBLE,
          to: CommissionStatus.LOCKED,
          ...(note ? { note } : {}),
        },
      });
      return updated;
    });
  }

  async pay(
    user: AuthenticatedUser,
    id: string,
    note?: string | null,
  ): Promise<CommissionWithRelations> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findUnique({
        where: { id },
        include: { salesOrder: { select: { branchId: true } } },
      });
      if (!commission) throw new NotFoundException('Commission not found');
      assertBranchAccess(user, commission.salesOrder.branchId);
      if (commission.status !== CommissionStatus.LOCKED) {
        throw new ConflictException(
          `Cannot pay commission in status ${commission.status} (must be LOCKED)`,
        );
      }
      const now = new Date();
      const after = await tx.commission.update({
        where: { id },
        data: {
          status: CommissionStatus.PAID,
          paidAt: now,
          ...(note ? { note } : {}),
        },
        include: COMMISSION_INCLUDE,
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: commission.salesOrder.branchId,
        entityType: 'Commission',
        entityId: commission.id,
        action: AuditAction.PAY,
        payload: {
          op: 'pay',
          from: CommissionStatus.LOCKED,
          to: CommissionStatus.PAID,
          paidAt: now.toISOString(),
          amount: decToNum(commission.amount),
          ...(note ? { note } : {}),
        },
      });
      return after;
    });

    await this.notifications.notify({
      userId: updated.recipientUserId,
      branchId: updated.salesOrder.branchId,
      title: `Commission paid: ${decToNum(updated.amount)}`,
      message: `Your commission of ${decToNum(updated.amount)} on order ${updated.salesOrder.orderNo} has been paid out.`,
      type: NotificationType.COMMISSION_PAID,
      metadata: {
        commissionId: updated.id,
        amount: decToNum(updated.amount),
        salesOrderId: updated.salesOrderId,
      },
      dedupeKey: `COMMISSION_PAID|${updated.id}`,
    });
    return updated;
  }

  /**
   * Revoke every non-PAID commission attached to a sales order. Called by
   * RefundsService.complete inside its own transaction.
   *
   * Returns the IDs of revoked commissions for audit-trail purposes.
   */
  async revokeForOrderWith(
    tx: Prisma.TransactionClient,
    params: {
      salesOrderId: string;
      refundId: string;
      reason: string;
      actorUserId: string | null;
      branchId: string | null;
    },
  ): Promise<string[]> {
    const candidates = await tx.commission.findMany({
      where: {
        salesOrderId: params.salesOrderId,
        status: { in: [...NON_PAID_STATUSES] },
      },
      select: { id: true, status: true, amount: true },
    });
    if (candidates.length === 0) return [];
    const now = new Date();
    await tx.commission.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: {
        status: CommissionStatus.REVOKED,
        revokedAt: now,
        revokedByRefundId: params.refundId,
        revokedReason: params.reason,
      },
    });
    for (const c of candidates) {
      await this.audit.recordWith(tx, {
        actorUserId: params.actorUserId,
        branchId: params.branchId,
        entityType: 'Commission',
        entityId: c.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'revoke',
          from: c.status,
          to: CommissionStatus.REVOKED,
          refundId: params.refundId,
          reason: params.reason,
          revokedAt: now.toISOString(),
          amount: decToNum(c.amount),
        },
      });
    }
    return candidates.map((c) => c.id);
  }

  // ───────────────────────── private helpers ─────────────────────────

  private buildPeriodFilter(
    query: CommissionQueryDto,
  ): Record<string, Prisma.DateTimeNullableFilter> {
    if (!query.from && !query.to) return {};
    const field = COMMISSION_PERIOD_COLUMN[query.periodField ?? 'CREATED_AT'];
    const range: Prisma.DateTimeNullableFilter = {};
    if (query.from) {
      range.gte = this.coerceRangeBoundary(query.from, 'start');
    }
    if (query.to) {
      range.lte = this.coerceRangeBoundary(query.to, 'end');
    }
    return { [field]: range };
  }

  private coerceRangeBoundary(raw: string, side: 'start' | 'end'): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const suffix = side === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
      return new Date(`${raw}${suffix}`);
    }
    return new Date(raw);
  }

  private async runBatch(
    ids: string[],
    handler: (id: string) => Promise<CommissionWithRelations>,
  ): Promise<CommissionBatchActionResult> {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    const results: CommissionBatchActionItemResult[] = [];

    for (const id of uniqueIds) {
      try {
        const commission = await handler(id);
        results.push({ id, success: true, commission });
      } catch (error) {
        results.push({
          id,
          success: false,
          error: error instanceof Error ? error.message : 'Batch action failed',
        });
      }
    }

    const succeededCount = results.filter((item) => item.success).length;
    return {
      requestedCount: ids.length,
      processedCount: uniqueIds.length,
      succeededCount,
      failedCount: results.length - succeededCount,
      results,
    };
  }

  private checkEligibility(
    type: CommissionType,
    flags: {
      depositPaid: boolean;
      appointmentBookedOrEvent: boolean;
      hasLead: boolean;
      hasLeadOwner: boolean;
    },
  ): { ok: true } | { ok: false; reason: string } {
    if (type === CommissionType.LEAD_REWARD) {
      if (!flags.depositPaid) {
        return { ok: false, reason: 'Deposit not yet satisfied' };
      }
      if (!flags.hasLead) {
        return { ok: false, reason: 'Sales order has no lead' };
      }
      if (!flags.hasLeadOwner) {
        return { ok: false, reason: 'Lead has no current owner' };
      }
      return { ok: true };
    }
    // SALES_COMMISSION
    if (!flags.appointmentBookedOrEvent) {
      return {
        ok: false,
        reason: 'No appointment booked nor service event recorded',
      };
    }
    return { ok: true };
  }
}

const NON_PAID_STATUSES: ReadonlyArray<CommissionStatus> = [
  CommissionStatus.PENDING,
  CommissionStatus.ELIGIBLE,
  CommissionStatus.LOCKED,
];

// Keep these symbols exported so `commissions.controller.ts` and other
// modules can re-use them without needing to widen the surface area of
// the service class.
export type { Commission, CommissionSnapshot, CommissionWithRelations };
