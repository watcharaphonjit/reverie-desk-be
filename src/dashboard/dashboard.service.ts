import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  CommissionStatus,
  LeadStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SalesOrderStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  isUnrestricted,
  scopedBranchFilter,
} from '../common/authz/branch-scope';
import { PrismaService } from '../prisma/prisma.service';

const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

const STOCK_EXPIRY_WINDOW_DAYS = 30;
const LOW_STOCK_THRESHOLD = 5;

/** Today as `[start, end)` in the server's local timezone. */
function todayBounds(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
function monthBounds(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}
function expiryWindow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + STOCK_EXPIRY_WINDOW_DAYS);
  return d;
}

/**
 * Dashboard KPI surface. Each endpoint returns a flat object of cards the
 * frontend renders directly. All counts come from `prisma.aggregate` /
 * `prisma.count` so they're cheap (each handler is ~6-10 indexed
 * queries).
 *
 * Branch scoping is enforced per-endpoint:
 *   - Executive: cross-branch view; restricted roles see only their own
 *     branch's slice silently (no 403, since the dashboard composes
 *     several KPIs).
 *   - Branch:    explicit branchId; caller's branch access is asserted.
 *   - Doctor:    targetUserId must be in caller's branch unless caller
 *     is unrestricted.
 *   - Telesales: same rule as doctor.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────── A. Executive ───────────────────────

  async executive(user: AuthenticatedUser) {
    const today = todayBounds();
    const month = monthBounds();
    const branchScope = scopedBranchFilter(user);
    const branchFilter: Prisma.SalesOrderWhereInput =
      branchScope === undefined ? {} : { branchId: branchScope };
    const warehouseFilter: Prisma.StockLotWhereInput =
      branchScope === undefined ? {} : { warehouse: { branchId: branchScope } };

    const [
      todayAgg,
      monthAgg,
      outstandingDeposits,
      todayAppointments,
      stockAlerts,
      pendingRefunds,
      pendingCommissions,
    ] = await Promise.all([
      this.prisma.salesOrder.aggregate({
        where: {
          ...branchFilter,
          createdAt: { gte: today.start, lt: today.end },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.salesOrder.aggregate({
        where: {
          ...branchFilter,
          createdAt: { gte: month.start, lt: month.end },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      // Orders requiring deposit but unsatisfied — sum of (depositRequired - paid).
      this.prisma.salesOrder.findMany({
        where: {
          ...branchFilter,
          depositSatisfiedAt: null,
          depositRequired: { gt: 0 },
          status: {
            notIn: [
              SalesOrderStatus.CANCELLED,
              SalesOrderStatus.COMPLETED,
              SalesOrderStatus.REFUNDED,
            ],
          },
        },
        select: {
          id: true,
          depositRequired: true,
          payments: {
            where: { status: PaymentStatus.SUCCESS },
            select: { amount: true },
          },
        },
      }),
      this.prisma.appointment.count({
        where: {
          ...(branchScope ? { branchId: branchScope } : {}),
          scheduledAt: { gte: today.start, lt: today.end },
        },
      }),
      this.prisma.stockLot.count({
        where: {
          ...warehouseFilter,
          status: 'ACTIVE',
          expiresAt: { lte: expiryWindow(), gte: new Date() },
        },
      }),
      this.prisma.refund.count({
        where: {
          status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED] },
          ...(branchScope ? { salesOrder: { branchId: branchScope } } : {}),
        },
      }),
      this.prisma.commission.count({
        where: {
          status: { in: [CommissionStatus.ELIGIBLE, CommissionStatus.LOCKED] },
          ...(branchScope ? { salesOrder: { branchId: branchScope } } : {}),
        },
      }),
    ]);

    const outstanding = outstandingDeposits.reduce((acc, o) => {
      const paid = o.payments.reduce((s, p) => s + decToNum(p.amount), 0);
      return acc + Math.max(decToNum(o.depositRequired) - paid, 0);
    }, 0);

    return {
      todaySales: {
        orders: todayAgg._count._all,
        amount: round2(decToNum(todayAgg._sum.totalAmount)),
      },
      monthSales: {
        orders: monthAgg._count._all,
        amount: round2(decToNum(monthAgg._sum.totalAmount)),
      },
      outstandingDeposits: round2(outstanding),
      totalAppointmentsToday: todayAppointments,
      stockAlerts,
      pendingRefunds,
      pendingCommissions,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────── B. Branch ───────────────────────

  async branch(user: AuthenticatedUser, branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    assertBranchAccess(user, branchId);

    const today = todayBounds();

    const [salesAgg, customersToday, appointmentsToday, activeLeads, lowStock] =
      await Promise.all([
        this.prisma.salesOrder.aggregate({
          where: {
            branchId,
            createdAt: { gte: today.start, lt: today.end },
          },
          _count: { _all: true },
          _sum: { totalAmount: true },
        }),
        this.prisma.customer.count({
          where: {
            currentBranchId: branchId,
            deletedAt: null,
            createdAt: { gte: today.start, lt: today.end },
          },
        }),
        this.prisma.appointment.count({
          where: {
            branchId,
            scheduledAt: { gte: today.start, lt: today.end },
          },
        }),
        this.prisma.lead.count({
          where: {
            branchId,
            deletedAt: null,
            status: {
              in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED],
            },
          },
        }),
        this.lowStockItems(branchId),
      ]);

    return {
      branch,
      branchSalesToday: {
        orders: salesAgg._count._all,
        amount: round2(decToNum(salesAgg._sum.totalAmount)),
      },
      customersToday,
      appointmentsToday,
      activeLeads,
      lowStockItems: lowStock,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────── C. Doctor ───────────────────────

  async doctor(requester: AuthenticatedUser, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        branchId: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (
      !isUnrestricted(requester) &&
      requester.id !== userId &&
      user.branchId !== requester.branchId
    ) {
      throw new ForbiddenException('Cross-branch dashboard access denied');
    }

    const today = todayBounds();

    const [appointmentsToday, statusCounts, completedServicesToday] =
      await Promise.all([
        this.prisma.appointment.count({
          where: {
            doctorUserId: userId,
            scheduledAt: { gte: today.start, lt: today.end },
          },
        }),
        this.prisma.appointment.groupBy({
          by: ['status'],
          where: {
            doctorUserId: userId,
            scheduledAt: { gte: today.start, lt: today.end },
          },
          _count: { _all: true },
        }),
        this.prisma.customerServiceEvent.count({
          where: {
            doctorUserId: userId,
            status: 'COMPLETED',
            completedAt: { gte: today.start, lt: today.end },
          },
        }),
      ]);

    const noShows =
      statusCounts.find((s) => s.status === AppointmentStatus.NO_SHOW)?._count
        ._all ?? 0;
    const completed =
      statusCounts.find((s) => s.status === AppointmentStatus.COMPLETED)?._count
        ._all ?? 0;

    return {
      user,
      appointmentsToday,
      completedAppointmentsToday: completed,
      completedServicesToday,
      noShows,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────── D. Telesales ───────────────────────

  async telesales(requester: AuthenticatedUser, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        branchId: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (
      !isUnrestricted(requester) &&
      requester.id !== userId &&
      user.branchId !== requester.branchId
    ) {
      throw new ForbiddenException('Cross-branch dashboard access denied');
    }

    const today = todayBounds();

    const [activeLeads, contactedToday, wonToday, commissionsPending] =
      await Promise.all([
        this.prisma.lead.count({
          where: {
            currentOwnerUserId: userId,
            deletedAt: null,
            status: {
              in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED],
            },
          },
        }),
        this.prisma.lead.count({
          where: {
            currentOwnerUserId: userId,
            deletedAt: null,
            status: LeadStatus.CONTACTED,
            updatedAt: { gte: today.start, lt: today.end },
          },
        }),
        this.prisma.lead.count({
          where: {
            currentOwnerUserId: userId,
            deletedAt: null,
            status: LeadStatus.WON,
            updatedAt: { gte: today.start, lt: today.end },
          },
        }),
        this.prisma.commission.aggregate({
          where: {
            recipientUserId: userId,
            status: {
              in: [CommissionStatus.ELIGIBLE, CommissionStatus.LOCKED],
            },
          },
          _count: { _all: true },
          _sum: { amount: true },
        }),
      ]);

    return {
      user,
      activeLeads,
      contactedToday,
      wonToday,
      commissionsPending: {
        count: commissionsPending._count._all,
        amount: round2(decToNum(commissionsPending._sum.amount)),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────── helpers ───────────────────────

  private async lowStockItems(branchId: string): Promise<
    Array<{
      stockItemId: string;
      name: string;
      sku: string;
      totalOnHand: number;
    }>
  > {
    // Aggregate per-item on-hand across the branch's warehouses (active
    // lots only). Filter to items at or below the configured threshold.
    const groups = await this.prisma.stockLot.groupBy({
      by: ['stockItemId'],
      where: {
        warehouse: { branchId },
        status: 'ACTIVE',
      },
      _sum: { quantityOnHand: true },
    });
    const candidates = groups
      .map((g) => ({
        stockItemId: g.stockItemId,
        totalOnHand: decToNum(g._sum.quantityOnHand),
      }))
      .filter((g) => g.totalOnHand <= LOW_STOCK_THRESHOLD);

    if (candidates.length === 0) return [];

    const items = await this.prisma.stockItem.findMany({
      where: {
        id: { in: candidates.map((c) => c.stockItemId) },
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true, sku: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    return candidates
      .filter((c) => byId.has(c.stockItemId))
      .map((c) => ({
        stockItemId: c.stockItemId,
        name: byId.get(c.stockItemId)!.name,
        sku: byId.get(c.stockItemId)!.sku,
        totalOnHand: c.totalOnHand,
      }))
      .sort((a, b) => a.totalOnHand - b.totalOnHand);
  }
}
