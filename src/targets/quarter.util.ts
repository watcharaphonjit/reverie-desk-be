import { Prisma, ServiceGroupCode } from '@prisma/client';

/**
 * Returns the half-open [start, end) UTC date range of `(year, quarter)`.
 *
 *   Q1 = [year-01-01, year-04-01)
 *   Q2 = [year-04-01, year-07-01)
 *   Q3 = [year-07-01, year-10-01)
 *   Q4 = [year-10-01, (year+1)-01-01)
 *
 * Half-open is the right shape for SQL filters:
 *   `WHERE completedAt >= start AND completedAt < end`
 * — no off-by-one on Mar-31 23:59:59.999, no DST drama because the
 * range is anchored to UTC midnight.
 *
 * Throws on invalid quarter (1..4) so callers don't have to repeat the
 * range-check after the DTO's `@Min(1) @Max(4)`.
 */
export function quarterRangeUTC(
  year: number,
  quarter: number,
): { start: Date; end: Date } {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new RangeError(`Quarter must be 1..4, got ${quarter}`);
  }
  // quarter=1 -> startMonth=0 (Jan), quarter=2 -> 3 (Apr), etc.
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  // End-of-quarter is start of the FIRST month of the next quarter.
  // For Q4 this rolls into next year, which `Date.UTC` handles natively.
  const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Asserts that the sum of `parts` equals `total` to within a 1-cent
 * tolerance (matches DECIMAL(18,2) precision). Throws a plain Error
 * with a diagnostic message; callers wrap it in `BadRequestException`.
 *
 * Why ±0.01: Prisma.Decimal sum is exact, but the inputs come over
 * JSON as `number`s (IEEE-754 doubles). 0.1 + 0.2 = 0.30000000000000004
 * — so a strict equality would reject sums that DECIMAL(18,2) would
 * happily round to the right answer. One-cent slack is the smallest
 * tolerance consistent with the stored precision.
 */
export function assertCategorySumMatchesTotal(
  total: number | Prisma.Decimal,
  parts: Array<number | Prisma.Decimal>,
): void {
  const totalDec = toDecimal(total);
  const sumDec = parts.reduce<Prisma.Decimal>(
    (acc, p) => acc.plus(toDecimal(p)),
    new Prisma.Decimal(0),
  );
  const diff = sumDec.minus(totalDec).abs();
  if (diff.greaterThan(new Prisma.Decimal('0.01'))) {
    throw new Error(
      `Category sum (${sumDec.toFixed(2)}) does not equal totalTarget (${totalDec.toFixed(2)})`,
    );
  }
}

/**
 * `actual / target * 100`, rounded to one decimal place. Returns `null`
 * when `target === 0` (avoid Infinity in JSON, which JSON can't even
 * represent — it serialises as `null` anyway, but explicit `null` is
 * easier for the frontend to switch on).
 */
export function progressPercent(
  actual: number | Prisma.Decimal,
  target: number | Prisma.Decimal,
): number | null {
  const t = toDecimal(target);
  if (t.isZero()) return null;
  const pct = toDecimal(actual).dividedBy(t).times(100);
  // Round to 1 dp via Decimal so 73.333... renders as 73.3, not 73.30000001.
  return Number(pct.toDecimalPlaces(1).toString());
}

const toDecimal = (v: number | Prisma.Decimal): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

// ───────────────────── Progress assembly ─────────────────────

export interface CategoryProgressView {
  group: ServiceGroupCode;
  target: number;
  actual: number;
  progress: number | null;
}

export interface AssembleArgs {
  branchId: string;
  branchName: string;
  year: number;
  quarter: number;
  rangeStart: Date;
  rangeEnd: Date;
  target: {
    totalTarget: Prisma.Decimal | number;
    categories: Array<{
      commissionGroup: ServiceGroupCode;
      targetAmount: Prisma.Decimal | number;
    }>;
  } | null;
  /** Raw rows from the per-group SUM query. NULL group is the "ungrouped" bucket. */
  actualsByGroup: Array<{
    commissionGroup: ServiceGroupCode | null;
    total: string | number | Prisma.Decimal | null;
  }>;
}

export interface AssembledProgress {
  branchId: string;
  branch: string;
  year: number;
  quarter: number;
  rangeStart: Date;
  rangeEnd: Date;
  totalTarget: number;
  totalActual: number;
  overallProgress: number | null;
  categories: CategoryProgressView[];
  ungroupedActual: number;
}

/**
 * Pure merge of a target row and per-group actuals into the
 * frontend-facing progress shape. Extracted from
 * `TargetProgressService` so unit tests can exercise the merge logic
 * (target vs actual, ungrouped bucket, percentage rounding) without
 * spinning up a database.
 *
 * `totalActual` is the sum of category actuals — INTENTIONALLY
 * excludes the ungrouped bucket, matching the design choice that
 * targets only count revenue that maps to a known commission group.
 * Ungrouped revenue is surfaced separately for ops visibility.
 */
export function assembleQuarterProgress(
  args: AssembleArgs,
): AssembledProgress {
  let ungroupedActual = new Prisma.Decimal(0);
  const actualByGroup = new Map<ServiceGroupCode, Prisma.Decimal>();
  for (const row of args.actualsByGroup) {
    const amount = coerceDecimal(row.total);
    if (row.commissionGroup === null || row.commissionGroup === undefined) {
      ungroupedActual = ungroupedActual.plus(amount);
    } else {
      const existing = actualByGroup.get(row.commissionGroup);
      actualByGroup.set(
        row.commissionGroup,
        existing ? existing.plus(amount) : amount,
      );
    }
  }

  const targetByGroup = new Map<ServiceGroupCode, Prisma.Decimal>();
  if (args.target) {
    for (const c of args.target.categories) {
      targetByGroup.set(c.commissionGroup, toDecimal(c.targetAmount));
    }
  }

  const allGroups = new Set<ServiceGroupCode>([
    ...targetByGroup.keys(),
    ...actualByGroup.keys(),
  ]);
  const categories: CategoryProgressView[] = Array.from(allGroups)
    .sort((a, b) => a.localeCompare(b))
    .map((group) => {
      const target = targetByGroup.get(group) ?? new Prisma.Decimal(0);
      const actual = actualByGroup.get(group) ?? new Prisma.Decimal(0);
      return {
        group,
        target: Number(target.toFixed(2)),
        actual: Number(actual.toFixed(2)),
        progress: progressPercent(actual, target),
      };
    });

  const totalTarget = args.target
    ? toDecimal(args.target.totalTarget)
    : new Prisma.Decimal(0);
  const totalActualDec = Array.from(actualByGroup.values()).reduce(
    (acc, v) => acc.plus(v),
    new Prisma.Decimal(0),
  );

  return {
    branchId: args.branchId,
    branch: args.branchName,
    year: args.year,
    quarter: args.quarter,
    rangeStart: args.rangeStart,
    rangeEnd: args.rangeEnd,
    totalTarget: Number(totalTarget.toFixed(2)),
    totalActual: Number(totalActualDec.toFixed(2)),
    overallProgress: progressPercent(totalActualDec, totalTarget),
    categories,
    ungroupedActual: Number(ungroupedActual.toFixed(2)),
  };
}

const coerceDecimal = (
  v: string | number | Prisma.Decimal | null | undefined,
): Prisma.Decimal => {
  if (v == null) return new Prisma.Decimal(0);
  if (v instanceof Prisma.Decimal) return v;
  return new Prisma.Decimal(v);
};
