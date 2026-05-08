import { Prisma, ServiceGroupCode } from '@prisma/client';
import {
  assembleQuarterProgress,
  assertCategorySumMatchesTotal,
  progressPercent,
  quarterRangeUTC,
} from './quarter.util';

/**
 * Pure-function tests for the targets-module helpers. The DB-touching
 * paths are exercised end-to-end by `scripts/smoke-branch-targets.ts`;
 * these specs cement the maths so a refactor can't silently corrupt
 * progress percentages or quarter boundaries.
 */

describe('quarterRangeUTC', () => {
  it('Q1 spans [Jan 1, Apr 1) UTC', () => {
    const { start, end } = quarterRangeUTC(2026, 1);
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('Q2 spans [Apr 1, Jul 1) UTC', () => {
    const { start, end } = quarterRangeUTC(2026, 2);
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('Q3 spans [Jul 1, Oct 1) UTC', () => {
    const { start, end } = quarterRangeUTC(2026, 3);
    expect(start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('Q4 spans [Oct 1, NEXT YEAR Jan 1) UTC', () => {
    const { start, end } = quarterRangeUTC(2026, 4);
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects a quarter outside 1..4', () => {
    expect(() => quarterRangeUTC(2026, 0)).toThrow(RangeError);
    expect(() => quarterRangeUTC(2026, 5)).toThrow(RangeError);
    expect(() => quarterRangeUTC(2026, 1.5)).toThrow(RangeError);
  });

  it('end is strictly after start (half-open invariant)', () => {
    for (let q = 1 as 1 | 2 | 3 | 4; q <= 4; q++) {
      const { start, end } = quarterRangeUTC(2026, q);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
  });
});

describe('assertCategorySumMatchesTotal', () => {
  it('accepts an exact sum (3M + 1M + 1M = 5M)', () => {
    expect(() =>
      assertCategorySumMatchesTotal(5_000_000, [3_000_000, 1_000_000, 1_000_000]),
    ).not.toThrow();
  });

  it('accepts within ±0.01 (IEEE-754 float drift slack)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS doubles. The helper must
    // tolerate this so reasonable sums don't get spuriously rejected.
    expect(() =>
      assertCategorySumMatchesTotal(0.3, [0.1, 0.2]),
    ).not.toThrow();
  });

  it('rejects when sum is short by more than a cent', () => {
    expect(() =>
      assertCategorySumMatchesTotal(5_000_000, [3_000_000, 1_000_000, 999_998]),
    ).toThrow(/does not equal totalTarget/);
  });

  it('rejects when sum overshoots by more than a cent', () => {
    expect(() =>
      assertCategorySumMatchesTotal(5_000_000, [3_000_000, 1_000_000, 1_000_002]),
    ).toThrow(/does not equal totalTarget/);
  });

  it('accepts Prisma.Decimal inputs', () => {
    expect(() =>
      assertCategorySumMatchesTotal(new Prisma.Decimal('5000000.00'), [
        new Prisma.Decimal('3000000.00'),
        new Prisma.Decimal('1000000.00'),
        new Prisma.Decimal('1000000.00'),
      ]),
    ).not.toThrow();
  });

  it('accepts an empty parts list when total is 0', () => {
    expect(() => assertCategorySumMatchesTotal(0, [])).not.toThrow();
  });

  it('rejects an empty parts list when total > 0', () => {
    expect(() => assertCategorySumMatchesTotal(100, [])).toThrow();
  });
});

describe('progressPercent', () => {
  it('1M / 5M → 20', () => {
    expect(progressPercent(1_000_000, 5_000_000)).toBe(20);
  });

  it('rounds 73.333... to 73.3 (one decimal)', () => {
    expect(progressPercent(2_200_000, 3_000_000)).toBe(73.3);
  });

  it('returns null when target is zero (avoid Infinity)', () => {
    expect(progressPercent(100, 0)).toBeNull();
  });

  it('returns 0 when actual is zero', () => {
    expect(progressPercent(0, 5_000_000)).toBe(0);
  });

  it('handles overshoot (actual > target)', () => {
    expect(progressPercent(6_000_000, 5_000_000)).toBe(120);
  });

  it('rounds to one decimal place even past 100%', () => {
    expect(progressPercent(5_555_000, 5_000_000)).toBe(111.1);
  });
});

describe('assembleQuarterProgress', () => {
  const baseArgs = {
    branchId: 'branch_bkk',
    branchName: 'Bangkok',
    year: 2026,
    quarter: 1,
    rangeStart: new Date('2026-01-01T00:00:00.000Z'),
    rangeEnd: new Date('2026-04-01T00:00:00.000Z'),
  };

  it('matches the spec example response shape (5M / 3.2M)', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 5_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 3_000_000 },
          { commissionGroup: ServiceGroupCode.RATE_SKIN, targetAmount: 1_000_000 },
          { commissionGroup: ServiceGroupCode.RATE_SURGERY, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '2200000' },
        { commissionGroup: ServiceGroupCode.RATE_SKIN, total: '500000' },
        { commissionGroup: ServiceGroupCode.RATE_SURGERY, total: '500000' },
      ],
    });
    expect(view.totalTarget).toBe(5_000_000);
    expect(view.totalActual).toBe(3_200_000);
    expect(view.overallProgress).toBe(64);
    const hair = view.categories.find((c) => c.group === 'RATE_HAIR');
    expect(hair).toEqual({
      group: 'RATE_HAIR',
      target: 3_000_000,
      actual: 2_200_000,
      progress: 73.3,
    });
  });

  it('returns 0% / 0 / null when no target exists yet (still surfaces actuals)', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: null,
      actualsByGroup: [
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '500000' },
      ],
    });
    expect(view.totalTarget).toBe(0);
    expect(view.totalActual).toBe(500_000);
    expect(view.overallProgress).toBeNull(); // can't divide by zero target
    expect(view.categories).toHaveLength(1);
    expect(view.categories[0].progress).toBeNull();
  });

  it('routes NULL-group actuals into ungroupedActual, NOT totalActual', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 1_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '700000' },
        { commissionGroup: null, total: '50000' },
      ],
    });
    expect(view.totalActual).toBe(700_000);
    expect(view.ungroupedActual).toBe(50_000);
    expect(view.overallProgress).toBe(70);
  });

  it('surfaces a target whose group has zero actuals (0% progress, not 0/0=null)', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 1_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [],
    });
    expect(view.categories[0].target).toBe(1_000_000);
    expect(view.categories[0].actual).toBe(0);
    expect(view.categories[0].progress).toBe(0);
    expect(view.overallProgress).toBe(0);
  });

  it('surfaces a group with actuals but no target (target=0, progress=null)', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 1_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '500000' },
        { commissionGroup: ServiceGroupCode.RATE_SKIN, total: '200000' },
      ],
    });
    const skin = view.categories.find((c) => c.group === 'RATE_SKIN');
    expect(skin).toEqual({
      group: 'RATE_SKIN',
      target: 0,
      actual: 200_000,
      progress: null,
    });
    // totalActual still includes the un-targeted group, because it has
    // a known commissionGroup; only NULL-group revenue is excluded.
    expect(view.totalActual).toBe(700_000);
  });

  it('returns categories sorted alphabetically by group code', () => {
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 3_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_SURGERY, targetAmount: 1_000_000 },
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 1_000_000 },
          { commissionGroup: ServiceGroupCode.RATE_SKIN, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [],
    });
    expect(view.categories.map((c) => c.group)).toEqual([
      'RATE_HAIR',
      'RATE_SKIN',
      'RATE_SURGERY',
    ]);
  });

  it('coalesces multiple actual rows for the same group (defensive)', () => {
    // Postgres GROUP BY with NULL pivot can occasionally yield two
    // rows for the same key in pathological multi-table joins; the
    // assembler must sum rather than overwrite.
    const view = assembleQuarterProgress({
      ...baseArgs,
      target: {
        totalTarget: 1_000_000,
        categories: [
          { commissionGroup: ServiceGroupCode.RATE_HAIR, targetAmount: 1_000_000 },
        ],
      },
      actualsByGroup: [
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '300000' },
        { commissionGroup: ServiceGroupCode.RATE_HAIR, total: '200000' },
      ],
    });
    expect(view.totalActual).toBe(500_000);
  });
});
