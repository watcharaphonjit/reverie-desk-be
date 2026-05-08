import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SalesOrderStatus, ServiceGroupCode } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertBranchAccess } from '../common/authz/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssembledProgress,
  assembleQuarterProgress,
  progressPercent,
  quarterRangeUTC,
} from './quarter.util';

/** One row in the `categories` array of the progress response. */
export type CategoryProgressView = AssembledProgress['categories'][number];

/** Response shape for `GET /targets/branch/:branchId/progress`. */
export type QuarterProgressView = AssembledProgress;

/** Internal: shape returned by the per-group SUM query. */
interface GroupActualRow {
  commissionGroup: ServiceGroupCode | null;
  /**
   * Postgres returns numeric SUM as `string` via the pg driver to
   * preserve precision. We coerce via `Prisma.Decimal` for safety.
   */
  total: string | number | Prisma.Decimal | null;
}

@Injectable()
export class TargetProgressService {
  constructor(private readonly prisma: PrismaService) {}

  // ────────────────────── Public surface ──────────────────────

  /**
   * Compute the live progress view for `(branchId, year, quarter)`.
   *
   * Authorization: the caller must be allowed to view the branch
   * (unrestricted roles see anything; branch-scoped roles only see
   * their own).
   *
   * Behaviour when no target row exists yet:
   *   - The endpoint still returns actuals (so dashboards work before
   *     a manager has gotten around to setting Q1 targets), but
   *     `totalTarget=0` and every category `target=0`, with
   *     `progress=null`.
   *
   * Performance: one branch-existence check, one parameterised raw SQL
   * `GROUP BY service.commissionGroupCode` aggregate over completed
   * orders in range, fetched concurrently with the target row. Linear
   * in the number of distinct groups (≤ 6 + NULL bucket), independent
   * of order count.
   */
  async getQuarterProgress(
    user: AuthenticatedUser,
    branchId: string,
    year: number,
    quarter: number,
  ): Promise<QuarterProgressView> {
    assertBranchAccess(user, branchId);

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const { start: rangeStart, end: rangeEnd } = quarterRangeUTC(
      year,
      quarter,
    );

    // Fetch the target (if set) and the actuals concurrently — the
    // queries are independent and we only ever block on the slower of
    // the two.
    const [target, actualsByGroup] = await Promise.all([
      this.prisma.branchQuarterTarget.findUnique({
        where: { branchId_year_quarter: { branchId, year, quarter } },
        select: {
          totalTarget: true,
          categories: {
            select: { commissionGroup: true, targetAmount: true },
          },
        },
      }),
      this.aggregateActualsByGroup(branchId, rangeStart, rangeEnd),
    ]);

    return assembleQuarterProgress({
      branchId,
      branchName: branch.name,
      year,
      quarter,
      rangeStart,
      rangeEnd,
      target,
      actualsByGroup,
    });
  }

  /**
   * Single-category drill-down. Useful for showing one card on the
   * dashboard ("How's hair doing?") without fetching the rest. Falls
   * through to `getQuarterProgress` and indexes by group, so the
   * authorization + range logic stays in one place.
   */
  async calculateCategoryProgress(
    user: AuthenticatedUser,
    branchId: string,
    year: number,
    quarter: number,
    group: ServiceGroupCode,
  ): Promise<CategoryProgressView> {
    const view = await this.getQuarterProgress(user, branchId, year, quarter);
    const found = view.categories.find((c) => c.group === group);
    return (
      found ?? {
        group,
        target: 0,
        actual: 0,
        progress: null,
      }
    );
  }

  /**
   * Returns just the overall percentage. Mostly here so callers (e.g.
   * future cross-branch dashboard cards) don't have to import the full
   * view shape.
   */
  async calculateOverallProgress(
    user: AuthenticatedUser,
    branchId: string,
    year: number,
    quarter: number,
  ): Promise<{
    totalTarget: number;
    totalActual: number;
    overallProgress: number | null;
  }> {
    const view = await this.getQuarterProgress(user, branchId, year, quarter);
    return {
      totalTarget: view.totalTarget,
      totalActual: view.totalActual,
      overallProgress: view.overallProgress,
    };
  }

  // ────────────────────── Internals ──────────────────────

  /**
   * Sum `SalesOrderItem.netAmount` for items belonging to completed
   * orders inside `[rangeStart, rangeEnd)`, grouped by the linked
   * service's `commissionGroupCode` (NULL grouped together as the
   * "ungrouped" bucket).
   *
   * Why raw SQL: Prisma's `groupBy` only supports top-level scalar
   * columns of one model, so grouping `SalesOrderItem.netAmount` by a
   * scalar from the joined `Service` table requires either
   * `findMany + JS aggregation` (lots of rows over the wire) or raw
   * SQL (one round-trip, aggregation done in pg). Raw SQL wins on
   * perf and is hermetic enough that the type assertion stays narrow.
   */
  private async aggregateActualsByGroup(
    branchId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<GroupActualRow[]> {
    const rows = await this.prisma.$queryRaw<GroupActualRow[]>`
      SELECT s."commissionGroupCode" AS "commissionGroup",
             SUM(soi."netAmount") AS "total"
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi."salesOrderId"
      JOIN services s ON s.id = soi."serviceId"
      WHERE so."branchId" = ${branchId}
        AND so.status = ${SalesOrderStatus.COMPLETED}::"SalesOrderStatus"
        AND so."completedAt" >= ${rangeStart}
        AND so."completedAt" < ${rangeEnd}
      GROUP BY s."commissionGroupCode"
    `;
    return rows;
  }
}

// Re-exported so the controller can render `progress` cells directly
// on ad-hoc category lookups without re-importing the util module.
export { progressPercent };
