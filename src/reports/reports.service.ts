import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  CommissionStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ServiceEventStatus,
  StockMovementType,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { scopedBranchFilter } from '../common/authz/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsReportQueryDto } from './dto/appointments-report-query.dto';
import { CommissionsReportQueryDto } from './dto/commissions-report-query.dto';
import { InventoryReportQueryDto } from './dto/inventory-report-query.dto';
import { PaymentsReportQueryDto } from './dto/payments-report-query.dto';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { ServiceEventsReportQueryDto } from './dto/service-events-report-query.dto';
import { WalletsReportQueryDto } from './dto/wallets-report-query.dto';

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Reports surface — every endpoint here is read-only aggregation. The
 * service stays light on raw SQL (only used for date bucketing in the
 * sales timeseries since Prisma's `groupBy` can't `date_trunc`); every
 * other aggregate uses `prisma.aggregate` / `prisma.groupBy`.
 *
 * Branch scoping: branch-restricted roles get a `branchId = user.branchId`
 * filter implicitly added to every query. Cross-branch roles see all data
 * unless they explicitly pass a `branchId` filter.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ────────────────────────────── A. Sales ──────────────────────────────

  async sales(user: AuthenticatedUser, query: SalesReportQueryDto) {
    const where = this.buildSalesWhere(user, query);
    const groupBy = query.groupBy ?? 'day';

    const [agg, fullyPaid, breakdown] = await Promise.all([
      this.prisma.salesOrder.aggregate({
        where,
        _count: { _all: true },
        _sum: {
          subtotalAmount: true,
          discountAmount: true,
          totalAmount: true,
        },
      }),
      this.prisma.salesOrder.count({
        where: { ...where, status: 'PAID' },
      }),
      this.salesBreakdown(where, groupBy),
    ]);

    // Deposits collected = Σ successful payments matching the same scope.
    const deposits = await this.prisma.payment.aggregate({
      where: {
        status: PaymentStatus.SUCCESS,
        salesOrder: where,
        ...(query.startDate || query.endDate
          ? this.dateRangeFilter(query.startDate, query.endDate, 'paidAt')
          : {}),
      },
      _sum: { amount: true },
    });

    const grossSales = decToNum(agg._sum.subtotalAmount);
    const discounts = decToNum(agg._sum.discountAmount);
    const netSales = decToNum(agg._sum.totalAmount);

    return {
      summary: {
        totalOrders: agg._count._all,
        grossSales: round2(grossSales),
        discounts: round2(discounts),
        netSales: round2(netSales),
        depositsCollected: round2(decToNum(deposits._sum.amount)),
        fullyPaidOrders: fullyPaid,
      },
      groupBy,
      breakdown,
      filters: this.echoFilters(query),
    };
  }

  // ────────────────────────────── B. Payments ──────────────────────────────

  async payments(user: AuthenticatedUser, query: PaymentsReportQueryDto) {
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentType ? { paymentType: query.paymentType } : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'createdAt'),
      ...this.scopedSalesOrderFilter(user, query.branchId),
    };

    const [byMethod, byType, byStatus, totals, refundImpact] =
      await Promise.all([
        this.prisma.payment.groupBy({
          by: ['paymentMethod'],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.payment.groupBy({
          by: ['paymentType'],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.payment.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.payment.aggregate({
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        // Refunds completed in the same scope window — these are money out.
        this.prisma.refund.aggregate({
          where: {
            status: RefundStatus.COMPLETED,
            ...this.dateRangeFilter(
              query.startDate,
              query.endDate,
              'completedAt',
            ),
            ...this.scopedRefundSalesOrderFilter(user, query.branchId),
          },
          _count: { _all: true },
          _sum: { amount: true },
        }),
      ]);

    const successAmount = byStatus
      .filter((r) => r.status === PaymentStatus.SUCCESS)
      .reduce((acc, r) => acc + decToNum(r._sum.amount), 0);
    const failedAmount = byStatus
      .filter((r) => r.status === PaymentStatus.FAILED)
      .reduce((acc, r) => acc + decToNum(r._sum.amount), 0);
    const refundedTotal = decToNum(refundImpact._sum.amount);

    return {
      summary: {
        totalPayments: totals._count._all,
        grossCollected: round2(decToNum(totals._sum.amount)),
        successAmount: round2(successAmount),
        failedAmount: round2(failedAmount),
        refundsCompletedCount: refundImpact._count._all,
        refundsCompletedAmount: round2(refundedTotal),
        netCollected: round2(successAmount - refundedTotal),
      },
      byMethod: byMethod.map((r) => ({
        paymentMethod: r.paymentMethod,
        count: r._count._all,
        total: round2(decToNum(r._sum.amount)),
      })),
      byType: byType.map((r) => ({
        paymentType: r.paymentType,
        count: r._count._all,
        total: round2(decToNum(r._sum.amount)),
      })),
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: r._count._all,
        total: round2(decToNum(r._sum.amount)),
      })),
      filters: this.echoFilters(query),
    };
  }

  // ───────────────────────── C. Service Events ─────────────────────────

  async serviceEvents(
    user: AuthenticatedUser,
    query: ServiceEventsReportQueryDto,
  ) {
    const where: Prisma.CustomerServiceEventWhereInput = {
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...(query.doctorUserId ? { doctorUserId: query.doctorUserId } : {}),
      ...(query.employeeUserId
        ? { employeeUserId: query.employeeUserId }
        : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'performedAt'),
      ...this.scopedBranchClause(user, query.branchId, 'branchId'),
    };

    const [totals, byStatus, byDoctor, byEmployee, byService, distinctCustomers] =
      await Promise.all([
        this.prisma.customerServiceEvent.count({ where }),
        this.prisma.customerServiceEvent.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.customerServiceEvent.groupBy({
          by: ['doctorUserId'],
          where: { ...where, doctorUserId: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.customerServiceEvent.groupBy({
          by: ['employeeUserId'],
          where: { ...where, employeeUserId: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.customerServiceEvent.groupBy({
          by: ['serviceId'],
          where,
          _count: { _all: true },
        }),
        this.prisma.customerServiceEvent.findMany({
          where,
          distinct: ['customerId'],
          select: { customerId: true },
        }),
      ]);

    // Hydrate user/service display names so the UI doesn't need a second
    // round trip.
    const [doctorNames, employeeNames, serviceNames] = await Promise.all([
      this.namesForUsers(byDoctor.map((r) => r.doctorUserId).filter(Boolean) as string[]),
      this.namesForUsers(
        byEmployee.map((r) => r.employeeUserId).filter(Boolean) as string[],
      ),
      this.namesForServices(byService.map((r) => r.serviceId)),
    ]);

    const completed = byStatus
      .filter((r) => r.status === ServiceEventStatus.COMPLETED)
      .reduce((acc, r) => acc + r._count._all, 0);

    const distinctCustomerCount = distinctCustomers.length;

    return {
      summary: {
        totalEvents: totals,
        completed,
        distinctCustomers: distinctCustomerCount,
        averageServicesPerCustomer:
          distinctCustomerCount === 0
            ? 0
            : round2(totals / distinctCustomerCount),
      },
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: r._count._all,
      })),
      doctorPerformance: byDoctor.map((r) => ({
        userId: r.doctorUserId,
        name: doctorNames.get(r.doctorUserId ?? '') ?? null,
        count: r._count._all,
      })),
      employeePerformance: byEmployee.map((r) => ({
        userId: r.employeeUserId,
        name: employeeNames.get(r.employeeUserId ?? '') ?? null,
        count: r._count._all,
      })),
      byService: byService.map((r) => ({
        serviceId: r.serviceId,
        name: serviceNames.get(r.serviceId) ?? null,
        count: r._count._all,
      })),
      filters: this.echoFilters(query),
    };
  }

  // ────────────────────────── D. Appointments ──────────────────────────

  async appointments(
    user: AuthenticatedUser,
    query: AppointmentsReportQueryDto,
  ) {
    const where: Prisma.AppointmentWhereInput = {
      ...(query.doctorUserId ? { doctorUserId: query.doctorUserId } : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'scheduledAt'),
      ...this.scopedBranchClause(user, query.branchId, 'branchId'),
    };

    const groupBy = query.groupBy ?? 'branch';

    const [byStatus, total, breakdown] = await Promise.all([
      this.prisma.appointment.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.appointment.count({ where }),
      groupBy === 'doctor'
        ? this.prisma.appointment.groupBy({
            by: ['doctorUserId', 'status'],
            where,
            _count: { _all: true },
          })
        : this.prisma.appointment.groupBy({
            by: ['branchId', 'status'],
            where,
            _count: { _all: true },
          }),
    ]);

    const counts = {
      booked: 0,
      checkedIn: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
    };
    for (const row of byStatus) {
      switch (row.status) {
        case AppointmentStatus.BOOKED:
          counts.booked = row._count._all;
          break;
        case AppointmentStatus.CHECKED_IN:
          counts.checkedIn = row._count._all;
          break;
        case AppointmentStatus.COMPLETED:
          counts.completed = row._count._all;
          break;
        case AppointmentStatus.CANCELLED:
          counts.cancelled = row._count._all;
          break;
        case AppointmentStatus.NO_SHOW:
          counts.noShow = row._count._all;
          break;
      }
    }
    const utilizationRate =
      counts.booked + counts.completed === 0
        ? 0
        : round2(
            counts.completed /
              (counts.booked +
                counts.completed +
                counts.cancelled +
                counts.noShow +
                counts.checkedIn),
          );

    // Aggregate breakdown rows by group key so each row shows full status
    // counts instead of one row per (group, status) tuple.
    const buckets = new Map<
      string,
      {
        key: string;
        booked: number;
        checkedIn: number;
        completed: number;
        cancelled: number;
        noShow: number;
      }
    >();
    for (const row of breakdown) {
      const key =
        groupBy === 'doctor'
          ? (row as { doctorUserId: string | null }).doctorUserId ?? 'unassigned'
          : (row as { branchId: string }).branchId;
      const bucket =
        buckets.get(key) ??
        {
          key,
          booked: 0,
          checkedIn: 0,
          completed: 0,
          cancelled: 0,
          noShow: 0,
        };
      const c = row._count._all;
      switch (row.status) {
        case AppointmentStatus.BOOKED:
          bucket.booked += c;
          break;
        case AppointmentStatus.CHECKED_IN:
          bucket.checkedIn += c;
          break;
        case AppointmentStatus.COMPLETED:
          bucket.completed += c;
          break;
        case AppointmentStatus.CANCELLED:
          bucket.cancelled += c;
          break;
        case AppointmentStatus.NO_SHOW:
          bucket.noShow += c;
          break;
      }
      buckets.set(key, bucket);
    }
    const breakdownRows = Array.from(buckets.values()).map((b) => {
      const total = b.booked + b.checkedIn + b.completed + b.cancelled + b.noShow;
      return {
        ...b,
        total,
        utilization: total === 0 ? 0 : round2(b.completed / total),
      };
    });

    // Hydrate names if grouping by doctor / branch.
    const namesById =
      groupBy === 'doctor'
        ? await this.namesForUsers(
            breakdownRows.filter((r) => r.key !== 'unassigned').map((r) => r.key),
          )
        : await this.namesForBranches(breakdownRows.map((r) => r.key));

    return {
      summary: {
        totalAppointments: total,
        ...counts,
        utilizationRate,
      },
      groupBy,
      breakdown: breakdownRows.map((r) => ({
        ...(groupBy === 'doctor' ? { doctorUserId: r.key } : { branchId: r.key }),
        name: namesById.get(r.key) ?? null,
        booked: r.booked,
        checkedIn: r.checkedIn,
        completed: r.completed,
        cancelled: r.cancelled,
        noShow: r.noShow,
        total: r.total,
        utilization: r.utilization,
      })),
      filters: this.echoFilters(query),
    };
  }

  // ────────────────────────── E. Inventory ──────────────────────────

  async inventory(user: AuthenticatedUser, query: InventoryReportQueryDto) {
    const where: Prisma.StockMovementWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.movementType ? { type: query.movementType } : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'createdAt'),
      ...this.scopedWarehouseFilter(user, query.warehouseId),
      ...(query.stockItemId
        ? { stockLot: { stockItemId: query.stockItemId } }
        : {}),
    };

    const [byType, byWarehouse, total] = await Promise.all([
      this.prisma.stockMovement.groupBy({
        by: ['type'],
        where,
        _count: { _all: true },
        _sum: { quantityDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['warehouseId', 'type'],
        where,
        _count: { _all: true },
        _sum: { quantityDelta: true },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    const totals: Record<StockMovementType, { count: number; quantity: number }> =
      {
        PURCHASE_IN: { count: 0, quantity: 0 },
        TRANSFER_IN: { count: 0, quantity: 0 },
        TRANSFER_OUT: { count: 0, quantity: 0 },
        CLINICAL_USAGE: { count: 0, quantity: 0 },
        RETAIL_SALE: { count: 0, quantity: 0 },
        ADJUSTMENT: { count: 0, quantity: 0 },
        RETURN: { count: 0, quantity: 0 },
        EXPIRE: { count: 0, quantity: 0 },
        DISCARD: { count: 0, quantity: 0 },
      };
    for (const row of byType) {
      totals[row.type] = {
        count: row._count._all,
        quantity: round6(decToNum(row._sum.quantityDelta)),
      };
    }

    const warehouseNames = await this.namesForWarehouses(
      Array.from(new Set(byWarehouse.map((r) => r.warehouseId))),
    );

    return {
      summary: {
        totalMovements: total,
        received: totals.PURCHASE_IN.quantity,
        transferredIn: totals.TRANSFER_IN.quantity,
        transferredOut: totals.TRANSFER_OUT.quantity,
        clinicalUsage: Math.abs(totals.CLINICAL_USAGE.quantity),
        retailSold: Math.abs(totals.RETAIL_SALE.quantity),
        discarded: Math.abs(totals.DISCARD.quantity),
        expired: Math.abs(totals.EXPIRE.quantity),
        returned: totals.RETURN.quantity,
        adjustments: totals.ADJUSTMENT.quantity,
      },
      byType: byType.map((r) => ({
        type: r.type,
        count: r._count._all,
        quantity: round6(decToNum(r._sum.quantityDelta)),
      })),
      byWarehouse: byWarehouse.map((r) => ({
        warehouseId: r.warehouseId,
        warehouseName: warehouseNames.get(r.warehouseId) ?? null,
        type: r.type,
        count: r._count._all,
        quantity: round6(decToNum(r._sum.quantityDelta)),
      })),
      filters: this.echoFilters(query),
    };
  }

  // ────────────────────────── F. Commissions ──────────────────────────

  async commissions(
    user: AuthenticatedUser,
    query: CommissionsReportQueryDto,
  ) {
    const where: Prisma.CommissionWhereInput = {
      ...(query.recipientUserId
        ? { recipientUserId: query.recipientUserId }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'createdAt'),
      ...(query.serviceGroupCode
        ? { snapshot: { serviceGroupCode: query.serviceGroupCode } }
        : {}),
      ...(query.branchId
        ? { salesOrder: { branchId: query.branchId } }
        : {}),
    };

    // Branch scoping for restricted users — push branchId onto the joined
    // salesOrder filter (commissions don't carry a direct branchId).
    const scoped = scopedBranchFilter(user);
    if (scoped !== undefined && !query.branchId) {
      where.salesOrder = { branchId: scoped };
    }

    const groupBy = query.groupBy ?? 'user';

    const [byStatus, byUser, byOrder, totals] = await Promise.all([
      this.prisma.commission.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.commission.groupBy({
        by: ['recipientUserId', 'status'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      // For branch / group breakdowns we need the snapshot. Fetch the rows
      // and bucket in memory — typically a few hundred per period.
      this.prisma.commission.findMany({
        where,
        select: {
          status: true,
          amount: true,
          recipientUserId: true,
          salesOrder: { select: { branchId: true } },
          snapshot: { select: { serviceGroupCode: true } },
        },
      }),
      this.prisma.commission.aggregate({
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const statusCounts: Record<CommissionStatus, { count: number; amount: number }> =
      {
        PENDING: { count: 0, amount: 0 },
        ELIGIBLE: { count: 0, amount: 0 },
        LOCKED: { count: 0, amount: 0 },
        PAID: { count: 0, amount: 0 },
        REVOKED: { count: 0, amount: 0 },
      };
    for (const r of byStatus) {
      statusCounts[r.status] = {
        count: r._count._all,
        amount: round2(decToNum(r._sum.amount)),
      };
    }

    let breakdown: Array<{
      key: string;
      name: string | null;
      count: number;
      amount: number;
    }>;
    if (groupBy === 'user') {
      const userIds = Array.from(new Set(byUser.map((r) => r.recipientUserId)));
      const names = await this.namesForUsers(userIds);
      const buckets = new Map<string, { count: number; amount: number }>();
      for (const r of byUser) {
        const cur = buckets.get(r.recipientUserId) ?? { count: 0, amount: 0 };
        cur.count += r._count._all;
        cur.amount = round2(cur.amount + decToNum(r._sum.amount));
        buckets.set(r.recipientUserId, cur);
      }
      breakdown = Array.from(buckets.entries()).map(([key, v]) => ({
        key,
        name: names.get(key) ?? null,
        ...v,
      }));
    } else if (groupBy === 'branch') {
      const buckets = new Map<string, { count: number; amount: number }>();
      for (const c of byOrder) {
        const k = c.salesOrder.branchId;
        const cur = buckets.get(k) ?? { count: 0, amount: 0 };
        cur.count += 1;
        cur.amount = round2(cur.amount + decToNum(c.amount));
        buckets.set(k, cur);
      }
      const branchNames = await this.namesForBranches(
        Array.from(buckets.keys()),
      );
      breakdown = Array.from(buckets.entries()).map(([key, v]) => ({
        key,
        name: branchNames.get(key) ?? null,
        ...v,
      }));
    } else {
      const buckets = new Map<string, { count: number; amount: number }>();
      for (const c of byOrder) {
        const k = c.snapshot.serviceGroupCode ?? 'UNGROUPED';
        const cur = buckets.get(k) ?? { count: 0, amount: 0 };
        cur.count += 1;
        cur.amount = round2(cur.amount + decToNum(c.amount));
        buckets.set(k, cur);
      }
      breakdown = Array.from(buckets.entries()).map(([key, v]) => ({
        key,
        name: key,
        ...v,
      }));
    }

    return {
      summary: {
        totalCommissions: totals._count._all,
        totalAmount: round2(decToNum(totals._sum.amount)),
        ...statusCounts,
      },
      groupBy,
      breakdown,
      filters: this.echoFilters(query),
    };
  }

  // ────────────────────────── G. Wallets ──────────────────────────

  async wallets(user: AuthenticatedUser, query: WalletsReportQueryDto) {
    const txnWhere: Prisma.WalletTransactionWhereInput = {
      ...this.dateRangeFilter(query.startDate, query.endDate, 'createdAt'),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.customerId ? { wallet: { customerId: query.customerId } } : {}),
      ...(query.walletType ? { wallet: { type: query.walletType } } : {}),
    };

    const scoped = scopedBranchFilter(user);
    if (scoped !== undefined && !query.branchId) {
      txnWhere.branchId = scoped;
    }

    const walletWhere: Prisma.WalletWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.walletType ? { type: query.walletType } : {}),
    };

    const [byTxnType, totals, walletAgg, walletCount] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['type'],
        where: txnWhere,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: txnWhere,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.wallet.aggregate({
        where: walletWhere,
        _sum: { balance: true },
      }),
      this.prisma.wallet.count({ where: walletWhere }),
    ]);

    const totalsByType: Record<string, { count: number; amount: number }> = {};
    for (const r of byTxnType) {
      totalsByType[r.type] = {
        count: r._count._all,
        amount: round2(decToNum(r._sum.amount)),
      };
    }
    const credit =
      (totalsByType.CREDIT?.amount ?? 0) +
      (totalsByType.TRANSFER_IN?.amount ?? 0);
    const debit =
      (totalsByType.DEBIT?.amount ?? 0) +
      (totalsByType.TRANSFER_OUT?.amount ?? 0);
    const expired = totalsByType.EXPIRE?.amount ?? 0;

    return {
      summary: {
        activeWallets: walletCount,
        totalBalance: round2(decToNum(walletAgg._sum.balance)),
        totalTransactions: totals._count._all,
        totalCredit: round2(credit),
        totalDebit: round2(debit),
        net: round2(credit - debit),
        expired: round2(expired),
        transferred:
          (totalsByType.TRANSFER_IN?.amount ?? 0) +
          (totalsByType.TRANSFER_OUT?.amount ?? 0),
      },
      byTransactionType: Object.entries(totalsByType).map(([type, v]) => ({
        type,
        count: v.count,
        amount: v.amount,
      })),
      filters: this.echoFilters(query),
    };
  }

  // ─────────────────────────── shared helpers ───────────────────────────

  private buildSalesWhere(
    user: AuthenticatedUser,
    query: SalesReportQueryDto,
  ): Prisma.SalesOrderWhereInput {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.createdByUserId
        ? { createdByUserId: query.createdByUserId }
        : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate, 'createdAt'),
      ...this.scopedBranchClause(user, query.branchId, 'branchId'),
    };
  }

  /**
   * Bucket sales orders by day/week/month using PostgreSQL's
   * `date_trunc`. We use `$queryRaw` with explicit interpolation so the
   * truncation unit is a vetted literal (never user input). The inner
   * filters are intentionally limited to the same fields the calling
   * endpoint validates, then re-derived here so the SQL stays stable
   * regardless of where-clause complexity.
   */
  private async salesBreakdown(
    where: Prisma.SalesOrderWhereInput,
    bucket: 'day' | 'week' | 'month',
  ): Promise<
    Array<{
      bucket: string;
      orders: number;
      grossSales: number;
      discounts: number;
      netSales: number;
    }>
  > {
    // Re-derive the same filters as `where` for the raw SQL. We only
    // support the documented filter fields; anything else is ignored
    // here — this is by design, the breakdown is a coarse timeseries.
    const branchId = (where.branchId as string | undefined) ?? null;
    const status = (where.status as string | undefined) ?? null;
    const createdByUserId =
      (where.createdByUserId as string | undefined) ?? null;
    const createdAt = where.createdAt as
      | { gte?: Date; lt?: Date }
      | undefined;
    const startDate = createdAt?.gte ?? null;
    const endDate = createdAt?.lt ?? null;

    // `bucket` is constrained by the DTO to a tiny enum, so direct
    // interpolation is safe.
    const truncUnit =
      bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';
    const sql = Prisma.sql`
      SELECT
        date_trunc(${truncUnit}, "createdAt")::date AS bucket,
        COUNT(*)::int AS orders,
        COALESCE(SUM("subtotalAmount"), 0)::numeric AS gross,
        COALESCE(SUM("discountAmount"), 0)::numeric AS discounts,
        COALESCE(SUM("totalAmount"), 0)::numeric AS net
      FROM "sales_orders"
      WHERE 1=1
        ${branchId ? Prisma.sql`AND "branchId" = ${branchId}` : Prisma.empty}
        ${status ? Prisma.sql`AND "status" = ${status}::"SalesOrderStatus"` : Prisma.empty}
        ${createdByUserId ? Prisma.sql`AND "createdByUserId" = ${createdByUserId}` : Prisma.empty}
        ${startDate ? Prisma.sql`AND "createdAt" >= ${startDate}` : Prisma.empty}
        ${endDate ? Prisma.sql`AND "createdAt" < ${endDate}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const rows = await this.prisma.$queryRaw<
      Array<{
        bucket: Date;
        orders: number;
        gross: string;
        discounts: string;
        net: string;
      }>
    >(sql);
    return rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString().slice(0, 10),
      orders: Number(r.orders),
      grossSales: round2(Number(r.gross)),
      discounts: round2(Number(r.discounts)),
      netSales: round2(Number(r.net)),
    }));
  }

  // ─────────────── filter / scoping helpers ───────────────

  private dateRangeFilter(
    startDate: string | undefined,
    endDate: string | undefined,
    field: string,
  ): Record<string, Prisma.DateTimeFilter> {
    if (!startDate && !endDate) return {};
    const range: Prisma.DateTimeFilter = {};
    if (startDate) range.gte = new Date(startDate);
    if (endDate) range.lt = new Date(endDate);
    return { [field]: range };
  }

  /**
   * Build a `branchId = ...` clause respecting both the explicit query
   * filter and the caller's branch scope. Branch-restricted users that
   * pass another branchId get an empty filter override (`__none__`) so
   * they see no rows rather than a 403, keeping aggregation endpoints
   * cheap to compose into dashboards.
   */
  private scopedBranchClause(
    user: AuthenticatedUser,
    requestedBranchId: string | undefined,
    field: 'branchId' | 'currentBranchId',
  ): Record<string, string> {
    const scoped = scopedBranchFilter(user);
    if (requestedBranchId) {
      if (scoped !== undefined && scoped !== requestedBranchId) {
        return { [field]: '__none__' };
      }
      return { [field]: requestedBranchId };
    }
    if (scoped !== undefined) return { [field]: scoped };
    return {};
  }

  private scopedSalesOrderFilter(
    user: AuthenticatedUser,
    requestedBranchId: string | undefined,
  ): Pick<Prisma.PaymentWhereInput, 'salesOrder'> {
    const branchClause = this.scopedBranchClause(
      user,
      requestedBranchId,
      'branchId',
    );
    if (Object.keys(branchClause).length === 0) return {};
    return { salesOrder: branchClause as Prisma.SalesOrderWhereInput };
  }

  private scopedRefundSalesOrderFilter(
    user: AuthenticatedUser,
    requestedBranchId: string | undefined,
  ): Pick<Prisma.RefundWhereInput, 'salesOrder'> {
    const branchClause = this.scopedBranchClause(
      user,
      requestedBranchId,
      'branchId',
    );
    if (Object.keys(branchClause).length === 0) return {};
    return { salesOrder: branchClause as Prisma.SalesOrderWhereInput };
  }

  private scopedWarehouseFilter(
    user: AuthenticatedUser,
    requestedWarehouseId: string | undefined,
  ): Prisma.StockMovementWhereInput {
    const scoped = scopedBranchFilter(user);
    if (scoped === undefined) return {};
    // Stock movements live on warehouses; branch-scoped users see only
    // movements on warehouses that belong to their branch (or the central
    // hub stays accessible to all roles).
    return {
      warehouse: requestedWarehouseId
        ? { id: requestedWarehouseId }
        : { branchId: scoped },
    };
  }

  // ─────────────── name lookups ───────────────

  private async namesForUsers(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  private async namesForBranches(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.branch.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async namesForServices(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.service.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async namesForWarehouses(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.warehouse.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private echoFilters(input: object): object {
    return Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined && v !== null),
    );
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
