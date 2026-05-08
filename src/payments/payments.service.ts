import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Payment,
  PaymentStatus,
  PaymentType,
  Prisma,
  SalesOrderStatus,
  WalletReferenceType,
  WalletTransactionType,
  WalletType,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { CommissionsService } from '../commissions/commissions.service';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TreatmentEntitlementsService } from '../treatment-entitlements/treatment-entitlements.service';
import { WalletService } from '../wallet/wallet.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentQueryDto } from './dto/payment-query.dto';
import { NotificationType } from '@prisma/client';

const PAYMENT_INCLUDE = {
  salesOrder: {
    select: {
      id: true,
      orderNo: true,
      branchId: true,
      status: true,
      totalAmount: true,
      depositRequired: true,
      depositSatisfiedAt: true,
    },
  },
  createdBy: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.PaymentInclude;

type PaymentWithRelations = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_INCLUDE;
}>;

const ORDER_BLOCKED_FOR_PAYMENT: ReadonlyArray<SalesOrderStatus> = [
  SalesOrderStatus.CANCELLED,
  SalesOrderStatus.COMPLETED,
  SalesOrderStatus.REFUNDED,
];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly commissions: CommissionsService,
    private readonly notifications: NotificationsService,
    private readonly entitlements: TreatmentEntitlementsService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreatePaymentDto,
  ): Promise<PaymentWithRelations> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: dto.salesOrderId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        createdByUserId: true,
        status: true,
        totalAmount: true,
        depositRequired: true,
        depositSatisfiedAt: true,
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    assertBranchAccess(user, order.branchId);

    if (ORDER_BLOCKED_FOR_PAYMENT.includes(order.status)) {
      throw new BadRequestException(
        `Cannot record payment on a ${order.status} sales order`,
      );
    }

    const total = toNumber(order.totalAmount);
    const depositRequired = toNumber(order.depositRequired);
    const paidSoFar = await this.sumSuccessPayments(this.prisma, order.id);
    const newPaidSum = round2(paidSoFar + dto.amount);
    if (newPaidSum > total) {
      throw new BadRequestException(
        `Payment exceeds outstanding balance (paid ${paidSoFar}, attempted +${dto.amount}, total ${total})`,
      );
    }

    const nextStatus = computeOrderStatus(order.status, newPaidSum, total);
    const shouldStampDeposit =
      order.depositSatisfiedAt === null &&
      depositRequired > 0 &&
      newPaidSum >= depositRequired;
    // Entitlements are minted exactly once per order — at the first
    // transition into status=PAID. Subsequent payments (or refunds that
    // re-pay) won't re-mint because the next time the engine runs
    // `order.status` is already PAID, so this guard is false.
    const shouldMintEntitlements =
      order.status !== SalesOrderStatus.PAID &&
      nextStatus === SalesOrderStatus.PAID;

    const payment = await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      // Update the order BEFORE creating the payment so the payment's
      // `include: salesOrder` returns the post-update snapshot to the caller.
      // Inside a transaction nothing is observable until commit, so the order
      // of writes doesn't change the atomicity guarantee.
      const orderUpdates: Prisma.SalesOrderUpdateInput = {};
      if (nextStatus !== order.status) orderUpdates.status = nextStatus;
      if (shouldStampDeposit) orderUpdates.depositSatisfiedAt = now;
      if (Object.keys(orderUpdates).length > 0) {
        await tx.salesOrder.update({
          where: { id: order.id },
          data: orderUpdates,
        });
      }

      const payment = await tx.payment.create({
        data: {
          salesOrderId: order.id,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          paymentType: dto.paymentType,
          status: PaymentStatus.SUCCESS,
          paidAt: now,
          createdByUserId: user.id,
          note: dto.note,
        },
        include: PAYMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: order.branchId,
        entityType: 'Payment',
        entityId: payment.id,
        action: AuditAction.CREATE,
        payload: {
          salesOrderId: order.id,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          paymentType: dto.paymentType,
          status: PaymentStatus.SUCCESS,
          paidTotalAfter: newPaidSum,
        },
      });

      if (Object.keys(orderUpdates).length > 0) {
        await this.audit.recordWith(tx, {
          actorUserId: user.id,
          branchId: order.branchId,
          entityType: 'SalesOrder',
          entityId: order.id,
          action: AuditAction.UPDATE,
          payload: {
            ...(nextStatus !== order.status
              ? { field: 'status', from: order.status, to: nextStatus }
              : {}),
            ...(shouldStampDeposit ? { depositSatisfied: true } : {}),
            triggeredByPaymentId: payment.id,
          },
        });
      }

      // Deposit-type payments (deposit + full+) post a CREDIT to the
      // customer's DEPOSIT wallet so receipts and ledger views reflect
      // the cash that came in. This is a strict spec rule: when
      // `paymentType === DEPOSIT`, write a wallet credit referencing
      // the payment.
      if (dto.paymentType === PaymentType.DEPOSIT) {
        await this.wallet.creditWith(tx, {
          customerId: order.customerId,
          walletType: WalletType.DEPOSIT,
          amount: dto.amount,
          type: WalletTransactionType.CREDIT,
          referenceType: WalletReferenceType.PAYMENT,
          referenceId: payment.id,
          branchId: order.branchId,
          note: `Deposit payment for order ${order.id}`,
          actorUserId: user.id,
        });
      }

      // When the deposit threshold is satisfied for the first time, kick
      // off commission evaluation. The engine is idempotent so repeated
      // calls (e.g. on later top-up payments) are safe; we still gate on
      // `shouldStampDeposit` to avoid wasted work on every payment.
      if (shouldStampDeposit) {
        await this.commissions.evaluateOrderWith(tx, order.id, user.id);
      }

      // Mint program entitlements on the first transition to PAID. Runs
      // inside the same `$transaction` so a failure here rolls back the
      // payment + order-status update — i.e. we never end up "fully
      // paid but no entitlements" or vice versa. Idempotent via the
      // `salesOrderItemId @unique` constraint on TreatmentEntitlement.
      if (shouldMintEntitlements) {
        await this.entitlements.createForPaidOrderWith(
          tx,
          order.id,
          user.id,
        );
      }

      return payment;
    });

    // Post-commit notifications. We fire after the transaction so a
    // notification failure can never roll back the payment, and so the
    // dedup key reflects the actual on-disk state.
    if (shouldStampDeposit) {
      if (order.createdByUserId) {
        await this.notifications.notify({
          userId: order.createdByUserId,
          branchId: order.branchId,
          title: `Deposit satisfied — ${payment.salesOrder.orderNo}`,
          message: `Order ${payment.salesOrder.orderNo} just hit its deposit threshold.`,
          type: NotificationType.DEPOSIT_PENDING,
          metadata: {
            salesOrderId: order.id,
            paymentId: payment.id,
            satisfied: true,
          },
          dedupeKey: `DEPOSIT_SATISFIED|${order.id}`,
        });
      }
      // Fan-out commission-eligible alerts to recipients (idempotent).
      await this.commissions.notifyEligibleForOrder(order.id);
    }
    return payment;
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: PaymentQueryDto,
  ): Promise<PaginatedResult<PaymentWithRelations>> {
    const where: Prisma.PaymentWhereInput = {
      ...(query.salesOrderId ? { salesOrderId: query.salesOrderId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...this.buildDateRangeFilter(query.from, query.to),
      ...this.buildBranchScopeFilter(user),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: PAYMENT_INCLUDE,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<PaymentWithRelations> {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    assertBranchAccess(user, payment.salesOrder.branchId);
    return payment;
  }

  // ───────────────────────── helpers ─────────────────────────
  private async sumSuccessPayments(
    client: Prisma.TransactionClient | PrismaService,
    salesOrderId: string,
  ): Promise<number> {
    const agg = await client.payment.aggregate({
      where: { salesOrderId, status: PaymentStatus.SUCCESS },
      _sum: { amount: true },
    });
    return toNumber(agg._sum.amount);
  }

  private buildDateRangeFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.PaymentWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { createdAt: range };
  }

  private buildBranchScopeFilter(
    user: AuthenticatedUser,
  ): Prisma.PaymentWhereInput {
    if (isUnrestricted(user)) return {};
    if (!user.branchId) {
      throw new ForbiddenException('User has no branch assignment');
    }
    return { salesOrder: { branchId: user.branchId } };
  }
}

// ─────────────────────── module-private utils ───────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toNumber = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};

/**
 * Map (paid sum, total) onto the next sales-order status.
 * - paid = 0           → CONFIRMED  (covers the case where the only payment is FAILED/VOIDED)
 * - 0 < paid < total   → PARTIALLY_PAID
 * - paid >= total      → PAID
 *
 * Tops out at PAID. Promotion to COMPLETED is owned by a separate
 * fulfilment workflow (appointments / CS), and the create flow will
 * never look at orders already in COMPLETED/CANCELLED/REFUNDED.
 */
export function computeOrderStatus(
  current: SalesOrderStatus,
  paid: number,
  total: number,
): SalesOrderStatus {
  if (paid <= 0) return SalesOrderStatus.CONFIRMED;
  if (paid >= total) return SalesOrderStatus.PAID;
  return SalesOrderStatus.PARTIALLY_PAID;
}
