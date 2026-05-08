/**
 * Smoke for the tiered service-group commission addendum.
 *
 * Walks every Success Criterion in the spec:
 *   ✓ Service linked to group           — uses Service.commissionGroupCode
 *   ✓ Tier matching works               — calculate against an exact tier
 *   ✓ Highest valid tier selected       — request between tiers, expect upper
 *   ✓ Mixed fixed/percentage works      — one tier of each type per group
 *   ✓ Multi-group order works           — sales order with services from
 *                                         two groups, expect two lines
 *   ✓ Bulk update works                 — bulk upsert + re-list + re-calc
 *
 * Plus validation rejections:
 *   ✓ Non-ascending minimums → 400
 *   ✓ Duplicate minimums → 400
 *   ✓ PERCENTAGE rate > 1 → 400
 *   ✓ Duplicate (branch, group) bundles → 400
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  SalesOrderStatus,
  ServiceGroupCode,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

interface ApiSuccess<T> {
  success: true;
  data: T;
}
interface ApiError {
  success: false;
  error: { code: string; message: string };
}
type ApiResponse<T> = ApiSuccess<T> | ApiError;

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: ApiResponse<T> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: ApiResponse<T>;
  try {
    parsed = JSON.parse(text) as ApiResponse<T>;
  } catch {
    parsed = {
      success: false,
      error: { code: 'PARSE', message: text || 'no body' },
    };
  }
  return { status: res.status, body: parsed };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok   ${msg}`);
}
function unwrap<T>(r: { body: ApiResponse<T> }): T {
  if (!r.body.success) {
    throw new Error(
      `Unexpected API failure: ${r.body.error.code} — ${r.body.error.message}`,
    );
  }
  return r.body.data;
}

interface BulkResp {
  bundlesUpdated: number;
  tiersWritten: number;
  rules: Array<{
    id: string;
    branchId: string;
    serviceGroupCode: ServiceGroupCode;
    valueType: 'FIXED' | 'PERCENTAGE';
    value: string;
    minAmount: string;
    isActive: boolean;
  }>;
}
interface CalcLine {
  serviceGroupCode: ServiceGroupCode;
  groupSubtotal: number;
  matchedRuleId: string | null;
  matchedTier: { minimum: number; rate: number; type: string } | null;
  computedCommission: number;
  itemRefs: string[];
}
interface CalcResp {
  salesOrderId: string;
  branchId: string;
  totalCommission: number;
  lines: CalcLine[];
  ungroupedItemRefs: string[];
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-6);

  // ── Bootstrap ──
  const branch = await prisma.branch.findFirst({ where: { status: 'ACTIVE' } });
  if (!branch) throw new Error('Need an active branch');
  const customer = await prisma.customer.findFirst({
    where: { deletedAt: null },
  });
  if (!customer) throw new Error('Need a customer');
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  if (!adminUser) throw new Error('Need admin user');

  // Two services, each in a different commission group.
  const skinService = await prisma.service.create({
    data: {
      code: `SKIN-${stamp}`,
      name: `Skin Smoke ${stamp}`,
      commissionGroupCode: ServiceGroupCode.RATE_SKIN,
      basePrice: 1000,
    },
  });
  const hairService = await prisma.service.create({
    data: {
      code: `HAIR-${stamp}`,
      name: `Hair Smoke ${stamp}`,
      commissionGroupCode: ServiceGroupCode.RATE_HAIR,
      basePrice: 1000,
    },
  });

  // Sales order: 1× skin @ 3,000 + 2× hair @ 2,500 = subtotal 8,000.
  // Skin group subtotal = 3,000; hair group subtotal = 5,000.
  const order = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-COM-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 8000,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 8000,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: skinService.id,
            quantity: 1,
            unitPrice: 3000,
            discountAmount: 0,
            netAmount: 3000,
            snapshotServiceCode: skinService.code,
            snapshotServiceName: skinService.name,
            snapshotUnitPrice: 3000,
          },
          {
            serviceId: hairService.id,
            quantity: 2,
            unitPrice: 2500,
            discountAmount: 0,
            netAmount: 5000,
            snapshotServiceCode: hairService.code,
            snapshotServiceName: hairService.name,
            snapshotUnitPrice: 2500,
          },
        ],
      },
    },
  });

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ── 1. Bulk upsert: two groups in one request ──
  // Skin ladder uses two FIXED tiers; Hair ladder mixes FIXED + PERCENTAGE
  // so the smoke exercises both calculator branches.
  const upsert = unwrap(
    await call<BulkResp>(
      'POST',
      '/commission-rules/bulk-upsert',
      {
        bundles: [
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_SKIN',
            tiers: [
              { minimum: 1, rate: 30, type: 'FIXED' },
              { minimum: 2001, rate: 50, type: 'FIXED' },
            ],
          },
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_HAIR',
            tiers: [
              { minimum: 1, rate: 100, type: 'FIXED' },
              { minimum: 5000, rate: 0.03, type: 'PERCENTAGE' },
            ],
          },
        ],
      },
      token,
    ),
  );
  expect(upsert.bundlesUpdated === 2, 'bulk upsert reports 2 bundles');
  expect(upsert.tiersWritten === 4, 'bulk upsert reports 4 total tiers');

  // ── 2. Service.commissionGroupCode round-trips through the schema ──
  const skinReread = await prisma.service.findUnique({
    where: { id: skinService.id },
  });
  expect(
    skinReread!.commissionGroupCode === 'RATE_SKIN',
    'Service linked to group (RATE_SKIN persists on Service)',
  );

  // ── 3. GET /commission-rules with filter ──
  const list = unwrap(
    await call<{ data: BulkResp['rules']; meta: { total: number } }>(
      'GET',
      `/commission-rules?branchId=${branch.id}&serviceGroupCode=RATE_HAIR&commissionType=SALES_COMMISSION`,
      undefined,
      token,
    ),
  );
  expect(
    list.data.every(
      (r) => r.branchId === branch.id && r.serviceGroupCode === 'RATE_HAIR',
    ),
    'GET filter by branchId+serviceGroupCode returns matching rows only',
  );
  expect(
    list.data.length === 2,
    'GET returns both SALES_COMMISSION HAIR tiers for this branch',
  );
  // Order ascending by minAmount (so the UI can render bottom-up).
  const sorted = [...list.data].sort(
    (a, b) => Number(a.minAmount) - Number(b.minAmount),
  );
  expect(
    sorted[0].minAmount === list.data[0].minAmount,
    'tiers come back ordered by minAmount asc',
  );

  // ── 4. Calculate against the sales order: multi-group + tier match ──
  const calc = unwrap(
    await call<CalcResp>(
      'POST',
      '/commission-rules/calculate',
      { salesOrderId: order.id },
      token,
    ),
  );
  expect(calc.lines.length === 2, 'multi-group order yields 2 lines');

  const skinLine = calc.lines.find((l) => l.serviceGroupCode === 'RATE_SKIN');
  const hairLine = calc.lines.find((l) => l.serviceGroupCode === 'RATE_HAIR');
  expect(!!skinLine && !!hairLine, 'both groups present in calc result');

  // Skin subtotal 3,000 → tier minimum 2001 wins (FIXED 50).
  expect(skinLine!.groupSubtotal === 3000, 'skin groupSubtotal = 3000');
  expect(
    skinLine!.matchedTier!.minimum === 2001 &&
      skinLine!.matchedTier!.type === 'FIXED' &&
      skinLine!.matchedTier!.rate === 50,
    'skin: highest matching tier is { minimum: 2001, FIXED 50 }',
  );
  expect(
    skinLine!.computedCommission === 50,
    'skin: FIXED commission = rate (50)',
  );

  // Hair subtotal 5,000 → tier minimum 5000 wins (PERCENTAGE 0.03).
  expect(hairLine!.groupSubtotal === 5000, 'hair groupSubtotal = 5000');
  expect(
    hairLine!.matchedTier!.minimum === 5000 &&
      hairLine!.matchedTier!.type === 'PERCENTAGE' &&
      hairLine!.matchedTier!.rate === 0.03,
    'hair: highest matching tier is { minimum: 5000, PERCENTAGE 0.03 }',
  );
  expect(
    hairLine!.computedCommission === 150,
    'hair: PERCENTAGE commission = 5000 * 0.03 = 150',
  );

  expect(
    calc.totalCommission === 200,
    'total commission = skin 50 + hair 150 = 200',
  );

  // ── 5. Highest-valid-tier selection (between two tiers) ──
  // Same skin ladder; build a fresh order at 1500 (between tier 1 @ 1 and
  // tier 2 @ 2001) and confirm tier 1 (FIXED 30) wins.
  const skinSrv2 = await prisma.service.create({
    data: {
      code: `SKIN-MID-${stamp}`,
      name: `Skin Mid ${stamp}`,
      commissionGroupCode: ServiceGroupCode.RATE_SKIN,
      basePrice: 1500,
    },
  });
  const order2 = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-COM2-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 1500,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 1500,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: skinSrv2.id,
            quantity: 1,
            unitPrice: 1500,
            discountAmount: 0,
            netAmount: 1500,
            snapshotServiceCode: skinSrv2.code,
            snapshotServiceName: skinSrv2.name,
            snapshotUnitPrice: 1500,
          },
        ],
      },
    },
  });
  const calc2 = unwrap(
    await call<CalcResp>(
      'POST',
      '/commission-rules/calculate',
      { salesOrderId: order2.id },
      token,
    ),
  );
  expect(
    calc2.lines.length === 1 &&
      calc2.lines[0].matchedTier!.minimum === 1 &&
      calc2.lines[0].computedCommission === 30,
    'order at 1500 picks lowest-tier minimum=1 (FIXED 30); higher tier ignored',
  );

  // ── 6. Re-upsert: replaces existing tiers atomically ──
  const reUpsert = unwrap(
    await call<BulkResp>(
      'POST',
      '/commission-rules/bulk-upsert',
      {
        bundles: [
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_SKIN',
            tiers: [{ minimum: 1, rate: 99, type: 'FIXED' }],
          },
        ],
      },
      token,
    ),
  );
  expect(reUpsert.tiersWritten === 1, 're-upsert wrote 1 new tier');
  // Old SALES_COMMISSION skin rules deactivated; only the new one active.
  // Filter by commissionType so other ladders (LEAD_REWARD, etc.) on the
  // same branch+group don't interfere with the count.
  const stillActive = await prisma.commissionRule.count({
    where: {
      branchId: branch.id,
      serviceGroupCode: 'RATE_SKIN',
      commissionType: 'SALES_COMMISSION',
      isActive: true,
    },
  });
  expect(
    stillActive === 1,
    're-upsert deactivated old SALES_COMMISSION skin tiers',
  );
  // Re-calc on order 1: skin should now pay 99 instead of 50.
  const calc3 = unwrap(
    await call<CalcResp>(
      'POST',
      '/commission-rules/calculate',
      { salesOrderId: order.id },
      token,
    ),
  );
  const skinLine3 = calc3.lines.find((l) => l.serviceGroupCode === 'RATE_SKIN');
  expect(
    skinLine3!.computedCommission === 99,
    're-upsert immediately reflected in calculate (skin = 99)',
  );

  // ── 7. Validation: non-ascending minimums rejected ──
  const badOrder = await call(
    'POST',
    '/commission-rules/bulk-upsert',
    {
      bundles: [
        {
          branchId: branch.id,
          serviceGroupCode: 'RATE_MEDICINE',
          tiers: [
            { minimum: 5000, rate: 1, type: 'FIXED' },
            { minimum: 1, rate: 1, type: 'FIXED' }, // out of order
          ],
        },
      ],
    },
    token,
  );
  expect(
    badOrder.status === 400,
    'non-ascending minimums → 400',
  );
  expect(
    !badOrder.body.success &&
      /ascending/i.test((badOrder.body as ApiError).error.message),
    'rejection message mentions ascending',
  );

  // ── 8. Validation: duplicate minimums rejected ──
  const dupMin = await call(
    'POST',
    '/commission-rules/bulk-upsert',
    {
      bundles: [
        {
          branchId: branch.id,
          serviceGroupCode: 'RATE_MEDICINE',
          tiers: [
            { minimum: 1, rate: 1, type: 'FIXED' },
            { minimum: 1, rate: 2, type: 'FIXED' },
          ],
        },
      ],
    },
    token,
  );
  expect(dupMin.status === 400, 'duplicate minimums → 400');

  // ── 9. Validation: PERCENTAGE rate > 1 rejected ──
  const badPct = await call(
    'POST',
    '/commission-rules/bulk-upsert',
    {
      bundles: [
        {
          branchId: branch.id,
          serviceGroupCode: 'RATE_SURGERY',
          tiers: [{ minimum: 1, rate: 1.5, type: 'PERCENTAGE' }],
        },
      ],
    },
    token,
  );
  expect(badPct.status === 400, 'PERCENTAGE rate > 1 → 400');

  // ── 10. Validation: duplicate (branch, group) bundles rejected ──
  const dupBundle = await call(
    'POST',
    '/commission-rules/bulk-upsert',
    {
      bundles: [
        {
          branchId: branch.id,
          serviceGroupCode: 'RATE_SURGERY',
          tiers: [{ minimum: 1, rate: 10, type: 'FIXED' }],
        },
        {
          branchId: branch.id,
          serviceGroupCode: 'RATE_SURGERY',
          tiers: [{ minimum: 1, rate: 20, type: 'FIXED' }],
        },
      ],
    },
    token,
  );
  expect(
    dupBundle.status === 400,
    'duplicate (branchId, group, type) bundles in one request → 400',
  );

  // ── 11. Order with an ungrouped service: that item is reported skipped ──
  const noGroupSrv = await prisma.service.create({
    data: {
      code: `NOGRP-${stamp}`,
      name: `No-group ${stamp}`,
      basePrice: 500,
    },
  });
  const orderNG = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-COM-NG-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 500,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 500,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: noGroupSrv.id,
            quantity: 1,
            unitPrice: 500,
            discountAmount: 0,
            netAmount: 500,
            snapshotServiceCode: noGroupSrv.code,
            snapshotServiceName: noGroupSrv.name,
            snapshotUnitPrice: 500,
          },
        ],
      },
    },
  });
  const calcNG = unwrap(
    await call<CalcResp>(
      'POST',
      '/commission-rules/calculate',
      { salesOrderId: orderNG.id },
      token,
    ),
  );
  expect(
    calcNG.lines.length === 0 && calcNG.totalCommission === 0,
    'order with only ungrouped services pays 0 commission',
  );
  expect(
    calcNG.ungroupedItemRefs.length === 1,
    'ungrouped items surface in ungroupedItemRefs',
  );

  await prisma.$disconnect();
  console.log('\nALL COMMISSION-RULES SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
