import { checkEntitlementGuards } from './treatment-entitlements.service';

/**
 * Pure-function unit tests for the entitlement booking/consume guards.
 *
 * `checkEntitlementGuards` mirrors the rejection rules enforced by
 * `assertBookable` (booking-time) and the SQL guard inside
 * `tryConsumeAppointmentWith` (consume-time). End-to-end coverage of
 * the actual DB path lives in `scripts/smoke-treatment-entitlements.ts`;
 * these specs cement the rule table so the rules cannot silently drift.
 */

const CUST = 'cust_alice';
const SVC = 'svc_hair_program';
const NOW = new Date('2026-05-08T12:00:00Z');

const baseEnt = {
  customerId: CUST,
  serviceId: SVC,
  totalSessions: 7,
  consumedSessions: 0,
  expiredAt: null as Date | null,
};

describe('checkEntitlementGuards (booking & consume)', () => {
  it('accepts a fresh entitlement for the right customer + service', () => {
    expect(checkEntitlementGuards(baseEnt, CUST, SVC, NOW)).toBeNull();
  });

  it('rejects when the entitlement belongs to a different customer', () => {
    expect(checkEntitlementGuards(baseEnt, 'cust_bob', SVC, NOW)).toBe(
      'WRONG_CUSTOMER',
    );
  });

  it('rejects when the entitlement is for a different service', () => {
    expect(checkEntitlementGuards(baseEnt, CUST, 'svc_acne_program', NOW)).toBe(
      'WRONG_SERVICE',
    );
  });

  it('rejects an expired entitlement (expiredAt strictly in the past)', () => {
    const expired = {
      ...baseEnt,
      expiredAt: new Date('2026-01-01T00:00:00Z'),
    };
    expect(checkEntitlementGuards(expired, CUST, SVC, NOW)).toBe('EXPIRED');
  });

  it('treats expiredAt === now as expired (boundary)', () => {
    const justExpired = { ...baseEnt, expiredAt: NOW };
    expect(checkEntitlementGuards(justExpired, CUST, SVC, NOW)).toBe('EXPIRED');
  });

  it('accepts an entitlement whose expiredAt is in the future', () => {
    const future = {
      ...baseEnt,
      expiredAt: new Date('2027-01-01T00:00:00Z'),
    };
    expect(checkEntitlementGuards(future, CUST, SVC, NOW)).toBeNull();
  });

  it('accepts when remaining sessions == 1 (last session bookable)', () => {
    const lastOne = { ...baseEnt, consumedSessions: 6, totalSessions: 7 };
    expect(checkEntitlementGuards(lastOne, CUST, SVC, NOW)).toBeNull();
  });

  it('rejects when consumed equals total (exhausted)', () => {
    const exhausted = { ...baseEnt, consumedSessions: 7, totalSessions: 7 };
    expect(checkEntitlementGuards(exhausted, CUST, SVC, NOW)).toBe('EXHAUSTED');
  });

  it('rejects when consumed somehow exceeds total (defensive)', () => {
    const over = { ...baseEnt, consumedSessions: 8, totalSessions: 7 };
    expect(checkEntitlementGuards(over, CUST, SVC, NOW)).toBe('EXHAUSTED');
  });

  it('reports WRONG_CUSTOMER before WRONG_SERVICE when both differ', () => {
    expect(checkEntitlementGuards(baseEnt, 'cust_bob', 'svc_other', NOW)).toBe(
      'WRONG_CUSTOMER',
    );
  });

  it('reports WRONG_SERVICE before EXPIRED when service mismatches an expired ent', () => {
    const expiredOther = {
      ...baseEnt,
      expiredAt: new Date('2026-01-01T00:00:00Z'),
    };
    expect(checkEntitlementGuards(expiredOther, CUST, 'svc_other', NOW)).toBe(
      'WRONG_SERVICE',
    );
  });

  it('reports EXPIRED before EXHAUSTED when both apply', () => {
    const both = {
      ...baseEnt,
      consumedSessions: 7,
      totalSessions: 7,
      expiredAt: new Date('2026-01-01T00:00:00Z'),
    };
    expect(checkEntitlementGuards(both, CUST, SVC, NOW)).toBe('EXPIRED');
  });
});

describe('total-session math (multi-quantity programs)', () => {
  // Mirrors `createForPaidOrderWith`'s computation:
  //   totalSessions = service.defaultSessions * max(1, item.quantity)
  // The smoke test exercises the actual SQL path; this case just locks
  // the closed-form invariant.
  const compute = (defaultSessions: number, quantity: number): number =>
    defaultSessions * Math.max(1, quantity);

  it('1 unit of a 7-session program → 7 total', () => {
    expect(compute(7, 1)).toBe(7);
  });

  it('2 units of a 7-session program → 14 total', () => {
    expect(compute(7, 2)).toBe(14);
  });

  it('3 units of a 5-session program → 15 total', () => {
    expect(compute(5, 3)).toBe(15);
  });

  it('treats quantity=0 as 1 (defensive)', () => {
    expect(compute(7, 0)).toBe(7);
  });
});
