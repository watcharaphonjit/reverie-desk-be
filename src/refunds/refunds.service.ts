import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  NotificationType,
  PaymentStatus,
  Prisma,
  Refund,
  RefundStatus,
  RoleCode,
  WalletReferenceType,
  WalletTransactionType,
  WalletType,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  scopedBranchFilter,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundQueryDto } from './dto/refund-query.dto';

const REFUND_INCLUDE = {
  salesOrder: {
    select: {
      id: true,
      orderNo: true,
      branchId: true,
      status: true,
      totalAmount: true,
    },
  },
  customer: { select: { id: true, code: true, fullName: true } },
  requestedByUser: { select: { id: true, fullName: true, email: true } },
  approvedByUser: { select: { id: true, fullName: true, email: true } },
  revokedCommissions: {
    select: {
      id: true,
      type: true,
      amount: true,
      status: true,
      recipientUserId: true,
    },
  },
} satisfies Prisma.RefundInclude;

type RefundWithRelations = Prisma.RefundGetPayload<{
  include: typeof REFUND_INCLUDE;
}>;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};

/**
 * Refund module – handles money-back requests against a sales order.
 *
 * State flow: REQUESTED → APPROVED → COMPLETED. REJECTED / CANCELLED can
 * be reached from REQUESTED (and CANCELLED from APPROVED) but completion
 * is the destructive op: it (a) revokes every non-PAID commission tied to
 * the order, and (b) optionally credits the customer's DEPOSIT wallet.
 *
 * Refund creation validates `amount ≤ Σ successful payments` so we never
 * approve a refund larger than the money actually collected.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly commissions: CommissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────── create ─────────────────────────

  async create(
    user: AuthenticatedUser,
    dto: CreateRefundDto,
  ): Promise<RefundWithRelations> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: dto.salesOrderId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        status: true,
        totalAmount: true,
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    assertBranchAccess(user, order.branchId);

    const paidSum = await this.sumSuccessPayments(this.prisma, order.id);
    const refundedSum = await this.sumExistingRefunds(this.prisma, order.id);
    const refundable = round2(paidSum - refundedSum);
    if (dto.amount > refundable + 1e-9) {
      throw new BadRequestException(
        `Refund amount ${dto.amount} exceeds refundable balance ${refundable} (paid ${paidSum}, already refunded ${refundedSum})`,
      );
    }

    const refund = await this.prisma.$transaction(async (tx) => {
      const refundNo = await generateRefundNo(tx);
      const created = await tx.refund.create({
        data: {
          refundNo,
          salesOrderId: order.id,
          customerId: order.customerId,
          requestedByUserId: user.id,
          refundType: dto.refundType,
          status: RefundStatus.REQUESTED,
          amount: new Prisma.Decimal(dto.amount),
          reason: dto.reason ?? null,
        },
        include: REFUND_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: order.branchId,
        entityType: 'Refund',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          op: 'create',
          refundNo,
          salesOrderId: order.id,
          amount: dto.amount,
          refundType: dto.refundType,
          reason: dto.reason ?? null,
          paidSum,
          previouslyRefunded: refundedSum,
          creditToWallet: dto.creditToWallet ?? true,
        },
      });
      return created;
    });

    // Post-commit alert to approvers (branch managers + super branch
    // managers + admins). The catch-up automation rule
    // `REFUND_APPROVAL` runs the same dedupeKey shape as a backstop.
    const approverIds = await this.findApprovers(order.branchId);
    if (approverIds.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      await this.notifications.notifyMany(approverIds, {
        title: `Refund needs approval: ${refund.refundNo}`,
        message: `Refund ${refund.refundNo} for ${dto.amount} on order ${order.id} is awaiting approval.`,
        type: NotificationType.REFUND_REQUEST,
        branchId: order.branchId,
        metadata: {
          refundId: refund.id,
          salesOrderId: order.id,
          amount: dto.amount,
        },
        dedupeKeyPrefix: `REFUND_REQUEST|${refund.id}|${today}`,
      });
    }
    return refund;
  }

  /**
   * Helper for refund-state notifications. Returns the user IDs of all
   * active branch managers (and super-branch / admins) responsible for
   * the given branch.
   */
  private async findApprovers(branchId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: {
        role: {
          code: {
            in: [
              RoleCode.BRANCH_MANAGER,
              RoleCode.SUPER_BRANCH_MANAGER,
              RoleCode.ADMIN,
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

  // ───────────────────────── list / detail ─────────────────────────

  async findAll(
    user: AuthenticatedUser,
    query: RefundQueryDto,
  ): Promise<PaginatedResult<RefundWithRelations>> {
    // Build the salesOrder relation filter explicitly so its branchId
    // constraint is the AND of (a) any caller-provided branchId filter and
    // (b) the caller's own branch when they're branch-scoped. Building the
    // relation filter as an explicit object avoids spreading a Prisma
    // relation-filter union (`SalesOrderWhereInput | SalesOrderRelationFilter`),
    // which trips TS narrowing on reassignment.
    const ownBranchScope = scopedBranchFilter(user); // string | undefined
    const salesOrderFilter: Prisma.SalesOrderWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(ownBranchScope ? { branchId: ownBranchScope } : {}),
    };
    const where: Prisma.RefundWhereInput = {
      ...(query.salesOrderId ? { salesOrderId: query.salesOrderId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.refundType ? { refundType: query.refundType } : {}),
      ...(Object.keys(salesOrderFilter).length > 0
        ? { salesOrder: salesOrderFilter }
        : {}),
    };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: REFUND_INCLUDE,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<RefundWithRelations> {
    const refund = await this.prisma.refund.findUnique({
      where: { id },
      include: REFUND_INCLUDE,
    });
    if (!refund) throw new NotFoundException('Refund not found');
    assertBranchAccess(user, refund.salesOrder.branchId);
    return refund;
  }

  // ───────────────────────── transitions ─────────────────────────

  async approve(
    user: AuthenticatedUser,
    id: string,
  ): Promise<RefundWithRelations> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.findUnique({
        where: { id },
        include: { salesOrder: { select: { branchId: true } } },
      });
      if (!refund) throw new NotFoundException('Refund not found');
      assertBranchAccess(user, refund.salesOrder.branchId);
      if (refund.status !== RefundStatus.REQUESTED) {
        throw new ConflictException(
          `Cannot approve refund in status ${refund.status} (must be REQUESTED)`,
        );
      }
      const now = new Date();
      const after = await tx.refund.update({
        where: { id },
        data: {
          status: RefundStatus.APPROVED,
          approvedByUserId: user.id,
          approvedAt: now,
        },
        include: REFUND_INCLUDE,
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: refund.salesOrder.branchId,
        entityType: 'Refund',
        entityId: refund.id,
        action: AuditAction.APPROVE,
        payload: {
          op: 'approve',
          from: RefundStatus.REQUESTED,
          to: RefundStatus.APPROVED,
          approvedAt: now.toISOString(),
        },
      });
      return after;
    });

    if (updated.requestedByUser) {
      await this.notifications.notify({
        userId: updated.requestedByUser.id,
        branchId: updated.salesOrder.branchId,
        title: `Refund approved: ${updated.refundNo}`,
        message: `Your refund request ${updated.refundNo} has been approved.`,
        type: NotificationType.REFUND_APPROVED,
        metadata: { refundId: updated.id },
        dedupeKey: `REFUND_APPROVED|${updated.id}`,
      });
    }
    return updated;
  }

  async reject(
    user: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<RefundWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.findUnique({
        where: { id },
        include: { salesOrder: { select: { branchId: true } } },
      });
      if (!refund) throw new NotFoundException('Refund not found');
      assertBranchAccess(user, refund.salesOrder.branchId);
      if (refund.status !== RefundStatus.REQUESTED) {
        throw new ConflictException(
          `Cannot reject refund in status ${refund.status} (must be REQUESTED)`,
        );
      }
      const updated = await tx.refund.update({
        where: { id },
        data: {
          status: RefundStatus.REJECTED,
          ...(reason ? { reason } : {}),
        },
        include: REFUND_INCLUDE,
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: refund.salesOrder.branchId,
        entityType: 'Refund',
        entityId: refund.id,
        action: AuditAction.UPDATE,
        payload: {
          op: 'reject',
          from: RefundStatus.REQUESTED,
          to: RefundStatus.REJECTED,
          reason: reason ?? null,
        },
      });
      return updated;
    });
  }

  async complete(
    user: AuthenticatedUser,
    id: string,
    options?: { creditToWallet?: boolean },
  ): Promise<RefundWithRelations> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.findUnique({
        where: { id },
        include: { salesOrder: { select: { branchId: true } } },
      });
      if (!refund) throw new NotFoundException('Refund not found');
      assertBranchAccess(user, refund.salesOrder.branchId);
      if (refund.status !== RefundStatus.APPROVED) {
        throw new ConflictException(
          `Cannot complete refund in status ${refund.status} (must be APPROVED)`,
        );
      }
      const now = new Date();

      // 1. Revoke non-paid commissions tied to the order.
      const revokedIds = await this.commissions.revokeForOrderWith(tx, {
        salesOrderId: refund.salesOrderId,
        refundId: refund.id,
        reason: `Refund ${refund.refundNo} completed`,
        actorUserId: user.id,
        branchId: refund.salesOrder.branchId,
      });

      // 2. Wallet credit (DEPOSIT) if requested.
      let walletTxnId: string | null = null;
      const creditToWallet = options?.creditToWallet ?? true;
      if (creditToWallet) {
        const result = await this.wallet.creditWith(tx, {
          customerId: refund.customerId,
          walletType: WalletType.DEPOSIT,
          amount: decToNum(refund.amount),
          type: WalletTransactionType.CREDIT,
          referenceType: WalletReferenceType.REFUND,
          referenceId: refund.id,
          branchId: refund.salesOrder.branchId,
          note: `Refund ${refund.refundNo}`,
          actorUserId: user.id,
        });
        walletTxnId = result.transaction.id;
      }

      // 3. Mark refund as completed.
      const updated = await tx.refund.update({
        where: { id },
        data: { status: RefundStatus.COMPLETED, completedAt: now },
        include: REFUND_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: refund.salesOrder.branchId,
        entityType: 'Refund',
        entityId: refund.id,
        action: AuditAction.COMPLETE,
        payload: {
          op: 'complete',
          from: RefundStatus.APPROVED,
          to: RefundStatus.COMPLETED,
          completedAt: now.toISOString(),
          revokedCommissionIds: revokedIds,
          walletTransactionId: walletTxnId,
          creditToWallet,
          amount: decToNum(refund.amount),
        },
      });

      return updated;
    });

    if (updated.requestedByUser) {
      await this.notifications.notify({
        userId: updated.requestedByUser.id,
        branchId: updated.salesOrder.branchId,
        title: `Refund completed: ${updated.refundNo}`,
        message: `Refund ${updated.refundNo} of ${decToNum(updated.amount)} has been completed.`,
        type: NotificationType.REFUND_APPROVED,
        metadata: {
          refundId: updated.id,
          amount: decToNum(updated.amount),
          status: RefundStatus.COMPLETED,
        },
        dedupeKey: `REFUND_COMPLETED|${updated.id}`,
      });
    }
    return updated;
  }

  // ───────────────────────── private helpers ─────────────────────────

  private async sumSuccessPayments(
    db: Prisma.TransactionClient | PrismaService,
    salesOrderId: string,
  ): Promise<number> {
    const agg = await db.payment.aggregate({
      where: { salesOrderId, status: PaymentStatus.SUCCESS },
      _sum: { amount: true },
    });
    return decToNum(agg._sum.amount);
  }

  private async sumExistingRefunds(
    db: Prisma.TransactionClient | PrismaService,
    salesOrderId: string,
  ): Promise<number> {
    // Reserve REQUESTED, APPROVED, and COMPLETED amounts so we never
    // over-allocate in flight. REJECTED / CANCELLED don't count.
    const agg = await db.refund.aggregate({
      where: {
        salesOrderId,
        status: {
          in: [
            RefundStatus.REQUESTED,
            RefundStatus.APPROVED,
            RefundStatus.COMPLETED,
          ],
        },
      },
      _sum: { amount: true },
    });
    return decToNum(agg._sum.amount);
  }
}

/**
 * Concurrency-safe refund number generator: `RFD-YYYYMMDD-####`.
 *
 * Uses a per-day Postgres advisory lock so concurrent refund creations
 * don't collide on the unique `refundNo` index.
 */
async function generateRefundNo(tx: Prisma.TransactionClient): Promise<string> {
  const now = new Date();
  const yyyymmdd =
    `${now.getUTCFullYear()}` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCDate()).padStart(2, '0')}`;
  const lockKey = `refund-no:${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const codePrefix = `RFD-${yyyymmdd}-`;
  const last = await tx.refund.findFirst({
    where: { refundNo: { startsWith: codePrefix } },
    orderBy: { refundNo: 'desc' },
    select: { refundNo: true },
  });
  const lastSeq = last
    ? parseInt(last.refundNo.slice(codePrefix.length), 10)
    : 0;
  const nextSeq = String(lastSeq + 1).padStart(4, '0');
  return `${codePrefix}${nextSeq}`;
}

export type { RefundWithRelations };
export type { Refund };
