import { CommissionRule, CommissionValueType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { pickHighestMatchingTier } from './commission-rules.service';

/**
 * Pure unit tests for the commission tier engine. These hit the exported
 * `pickHighestMatchingTier` and exercise the same selection rule used by
 * `calculateForOrder`.
 *
 * Why pure tests? The DB-backed integration paths are already covered
 * end-to-end by `scripts/smoke-commission-rules.ts` and
 * `scripts/smoke-commission-refund-wallet.ts`. These specs cement the
 * contract of the *math itself* so a refactor to the lookup loop can't
 * silently break the spec table.
 */

function makeRule(overrides: Partial<CommissionRule>): CommissionRule {
  return {
    id: overrides.id ?? 'rule-' + Math.random().toString(36).slice(2, 8),
    roleId: null,
    commissionType: 'SALES_COMMISSION',
    valueType: overrides.valueType ?? CommissionValueType.FIXED,
    value: overrides.value as Prisma.Decimal,
    branchId: 'branch-1',
    serviceGroupCode: overrides.serviceGroupCode ?? 'RATE_SKIN',
    minAmount: overrides.minAmount as Prisma.Decimal | null,
    maxAmount: null,
    startsAt: new Date('2025-01-01'),
    endsAt: null,
    isActive: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

/** Round to two decimals the same way the service does. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Replicates the FIXED / PERCENTAGE branch in `calculateForOrder`. */
function compute(rule: CommissionRule, subtotal: number): number {
  const rate = Number(rule.value.toString());
  return rule.valueType === CommissionValueType.FIXED
    ? round2(rate)
    : round2(subtotal * rate);
}

describe('CommissionRulesService — tier matching', () => {
  // The canonical RATE_SKIN ladder from the spec table.
  const skin: CommissionRule[] = [
    makeRule({
      id: 'tier-skin-1',
      minAmount: dec(1),
      value: dec(30),
      valueType: CommissionValueType.FIXED,
    }),
    makeRule({
      id: 'tier-skin-2001',
      minAmount: dec(2001),
      value: dec(50),
      valueType: CommissionValueType.FIXED,
    }),
    makeRule({
      id: 'tier-skin-5000',
      minAmount: dec(5000),
      value: dec(0.03),
      valueType: CommissionValueType.PERCENTAGE,
    }),
    makeRule({
      id: 'tier-skin-10000',
      minAmount: dec(10000),
      value: dec(0.05),
      valueType: CommissionValueType.PERCENTAGE,
    }),
    makeRule({
      id: 'tier-skin-20000',
      minAmount: dec(20000),
      value: dec(0.07),
      valueType: CommissionValueType.PERCENTAGE,
    }),
  ];

  describe('pickHighestMatchingTier', () => {
    it('returns null when no rule matches (subtotal below smallest minimum)', () => {
      expect(pickHighestMatchingTier(skin, 0)).toBeNull();
    });

    it('selects the lowest tier when subtotal sits at the floor', () => {
      const r = pickHighestMatchingTier(skin, 1);
      expect(r?.id).toBe('tier-skin-1');
    });

    it('subtotal 3000 picks the 2001 tier', () => {
      const r = pickHighestMatchingTier(skin, 3000);
      expect(r?.id).toBe('tier-skin-2001');
    });

    it('subtotal 15000 picks the 10000 tier', () => {
      const r = pickHighestMatchingTier(skin, 15000);
      expect(r?.id).toBe('tier-skin-10000');
    });

    it('subtotal exactly at a threshold uses that tier', () => {
      expect(pickHighestMatchingTier(skin, 5000)?.id).toBe('tier-skin-5000');
      expect(pickHighestMatchingTier(skin, 20000)?.id).toBe('tier-skin-20000');
    });

    it('selection is order-independent — shuffled input picks the same row', () => {
      const shuffled = [...skin].reverse();
      expect(pickHighestMatchingTier(shuffled, 3000)?.id).toBe('tier-skin-2001');
      expect(pickHighestMatchingTier(shuffled, 15000)?.id).toBe('tier-skin-10000');
    });

    it('rules with null minAmount are ignored (defensive)', () => {
      const withNull = [
        ...skin,
        makeRule({
          id: 'broken',
          minAmount: null,
          value: dec(999),
          valueType: CommissionValueType.FIXED,
        }),
      ];
      const r = pickHighestMatchingTier(withNull, 3000);
      expect(r?.id).toBe('tier-skin-2001');
    });
  });

  describe('FIXED vs PERCENTAGE math', () => {
    it('FIXED rule of 50 returns 50 regardless of subtotal', () => {
      const fixed = makeRule({
        id: 'fix-50',
        minAmount: dec(2001),
        value: dec(50),
        valueType: CommissionValueType.FIXED,
      });
      expect(compute(fixed, 3000)).toBe(50);
      expect(compute(fixed, 99999)).toBe(50);
    });

    it('PERCENTAGE rule of 0.05 on 10000 returns 500', () => {
      const pct = makeRule({
        id: 'pct-5',
        minAmount: dec(10000),
        value: dec(0.05),
        valueType: CommissionValueType.PERCENTAGE,
      });
      expect(compute(pct, 10000)).toBe(500);
    });

    it('PERCENTAGE rule of 0.03 on 5000 returns 150 (boundary)', () => {
      const pct = makeRule({
        id: 'pct-3',
        minAmount: dec(5000),
        value: dec(0.03),
        valueType: CommissionValueType.PERCENTAGE,
      });
      expect(compute(pct, 5000)).toBe(150);
    });

    it('rounds to 2 decimal places (avoids float drift)', () => {
      const pct = makeRule({
        id: 'pct-7',
        minAmount: dec(20000),
        value: dec(0.07),
        valueType: CommissionValueType.PERCENTAGE,
      });
      // 23333.33 * 0.07 = 1633.3331 → rounds to 1633.33
      expect(compute(pct, 23333.33)).toBe(1633.33);
    });
  });

  describe('end-to-end: matched tier → computed amount', () => {
    const cases: Array<{
      subtotal: number;
      expectedTier: string;
      expectedAmount: number;
    }> = [
      { subtotal: 1, expectedTier: 'tier-skin-1', expectedAmount: 30 },
      { subtotal: 1500, expectedTier: 'tier-skin-1', expectedAmount: 30 },
      { subtotal: 2001, expectedTier: 'tier-skin-2001', expectedAmount: 50 },
      { subtotal: 3000, expectedTier: 'tier-skin-2001', expectedAmount: 50 },
      { subtotal: 5000, expectedTier: 'tier-skin-5000', expectedAmount: 150 },
      { subtotal: 7500, expectedTier: 'tier-skin-5000', expectedAmount: 225 },
      { subtotal: 10000, expectedTier: 'tier-skin-10000', expectedAmount: 500 },
      { subtotal: 15000, expectedTier: 'tier-skin-10000', expectedAmount: 750 },
      { subtotal: 20000, expectedTier: 'tier-skin-20000', expectedAmount: 1400 },
      { subtotal: 50000, expectedTier: 'tier-skin-20000', expectedAmount: 3500 },
    ];

    for (const c of cases) {
      it(`subtotal ${c.subtotal} → tier ${c.expectedTier} → amount ${c.expectedAmount}`, () => {
        const matched = pickHighestMatchingTier(skin, c.subtotal);
        expect(matched?.id).toBe(c.expectedTier);
        expect(compute(matched!, c.subtotal)).toBe(c.expectedAmount);
      });
    }
  });
});
