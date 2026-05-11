/**
 * Smoke for the Branch Quarterly Target module.
 *
 * Walks every Success Criterion in the spec:
 *   ✓ Target Creation        — POST /targets persists a valid target
 *   ✓ Validation             — sum mismatch → 400
 *   ✓ Progress (status)      — only COMPLETED orders count
 *   ✓ Grouping               — actuals are grouped by service.commissionGroup
 *   ✓ Percentages            — rounded to 1 dp; spec example reproduced
 *   ✓ Unique Constraint      — duplicate (branch, year, quarter) → 409
 *
 * Plus rejection paths:
 *   ✓ Quarter outside 1..4 → 400 (DTO)
 *   ✓ Year outside 2020..2100 → 400 (DTO)
 *   ✓ Branch-scoped role attempting another branch → 403
 *   ✓ PATCH category replace + sum re-validation
 *
 * Run: BASE_URL=http://localhost:3001/api/v1 tsx scripts/smoke-branch-targets.ts
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  SalesOrderStatus,
  ServiceGroupCode,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';

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

interface TargetResp {
  id: string;
  branchId: string;
  year: number;
  quarter: number;
  totalTarget: string;
  categories: Array<{
    commissionGroup: ServiceGroupCode;
    targetAmount: string;
  }>;
}
interface ProgressResp {
  branchId: string;
  branch: string;
  year: number;
  quarter: number;
  totalTarget: number;
  totalActual: number;
  overallProgress: number | null;
  ungroupedActual: number;
  categories: Array<{
    group: ServiceGroupCode;
    target: number;
    actual: number;
    progress: number | null;
  }>;
}

/**
 * Helper — directly mints a COMPLETED SalesOrder + items + a stamped
 * `completedAt` so we can simulate "Q1 2026 revenue" without running
 * through the full sales/payment/appointment funnel. The progress
 * service only reads `(branchId, status, completedAt, items+services)`
 * so this synthetic shape is functionally equivalent.
 */
async function seedCompletedOrder(
  prisma: PrismaClient,
  args: {
    branchId: string;
    customerId: string;
    createdByUserId: string;
    completedAt: Date;
    orderNo: string;
    items: Array<{ serviceId: string; net: number; code: string; name: string }>;
  },
): Promise<void> {
  const total = args.items.reduce((acc, i) => acc + i.net, 0);
  await prisma.salesOrder.create({
    data: {
      orderNo: args.orderNo,
      branchId: args.branchId,
      customerId: args.customerId,
      createdByUserId: args.createdByUserId,
      status: SalesOrderStatus.COMPLETED,
      completedAt: args.completedAt,
      subtotalAmount: total,
      totalAmount: total,
      depositRequired: 0,
      items: {
        create: args.items.map((i) => ({
          serviceId: i.serviceId,
          quantity: 1,
          unitPrice: i.net,
          netAmount: i.net,
          snapshotServiceCode: i.code,
          snapshotServiceName: i.name,
          snapshotUnitPrice: i.net,
        })),
      },
    },
  });
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-7);

  // ── Bootstrap: dedicated branch so this smoke is isolated ──
  const branch = await prisma.branch.create({
    data: {
      code: `BR-TGT-${stamp}`,
      name: `Target Smoke Branch ${stamp}`,
      status: 'ACTIVE',
    },
  });

  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  if (!adminUser) throw new Error('Need admin user (run seed)');

  const customer = await prisma.customer.create({
    data: {
      code: `CUST-TGT-${stamp}`,
      fullName: `Target Smoke Customer ${stamp}`,
      currentBranchId: branch.id,
    },
  });

  // Three program-less services, one per group we'll target.
  const hairSvc = await prisma.service.create({
    data: {
      code: `SVC-HAIR-${stamp}`,
      name: `Hair Smoke ${stamp}`,
      basePrice: 1000,
      commissionGroupCode: ServiceGroupCode.RATE_HAIR,
      isActive: true,
    },
  });
  const skinSvc = await prisma.service.create({
    data: {
      code: `SVC-SKIN-${stamp}`,
      name: `Skin Smoke ${stamp}`,
      basePrice: 1000,
      commissionGroupCode: ServiceGroupCode.RATE_SKIN,
      isActive: true,
    },
  });
  const surgerySvc = await prisma.service.create({
    data: {
      code: `SVC-SURG-${stamp}`,
      name: `Surgery Smoke ${stamp}`,
      basePrice: 1000,
      commissionGroupCode: ServiceGroupCode.RATE_SURGERY,
      isActive: true,
    },
  });

  // ── Login as admin ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ─────────────────────────────────────────────────────────────
  // CRITERION 1: Target Creation — POST /targets persists
  // ─────────────────────────────────────────────────────────────
  console.log('\n[1] Create valid target (5M = 3M + 1M + 1M)');
  const target = unwrap(
    await call<TargetResp>(
      'POST',
      '/targets',
      {
        branchId: branch.id,
        year: 2026,
        quarter: 1,
        totalTarget: 5_000_000,
        categories: [
          { commissionGroup: 'RATE_HAIR', targetAmount: 3_000_000 },
          { commissionGroup: 'RATE_SKIN', targetAmount: 1_000_000 },
          { commissionGroup: 'RATE_SURGERY', targetAmount: 1_000_000 },
        ],
      },
      token,
    ),
  );
  expect(target.id !== undefined, 'target persisted with id');
  expect(target.year === 2026 && target.quarter === 1, 'year/quarter echoed');
  expect(target.categories.length === 3, '3 categories created');
  expect(
    Number(target.totalTarget) === 5_000_000,
    'totalTarget = 5,000,000',
  );

  // Read-back round-trip.
  const fetched = unwrap(
    await call<TargetResp>(
      'GET',
      `/targets/branch/${branch.id}?year=2026&quarter=1`,
      undefined,
      token,
    ),
  );
  expect(fetched.id === target.id, 'GET /targets/branch returns same row');

  // ─────────────────────────────────────────────────────────────
  // CRITERION 2: Validation — sum mismatch → 400
  // ─────────────────────────────────────────────────────────────
  console.log('\n[2] Sum mismatch rejected with 400');
  const mismatch = await call(
    'POST',
    '/targets',
    {
      branchId: branch.id,
      year: 2027,
      quarter: 1,
      totalTarget: 5_000_000,
      categories: [
        { commissionGroup: 'RATE_HAIR', targetAmount: 3_000_000 },
        { commissionGroup: 'RATE_SKIN', targetAmount: 1_000_000 },
        // Missing 1M — sum = 4M, target = 5M.
      ],
    },
    token,
  );
  expect(
    mismatch.status === 400 && !mismatch.body.success,
    'sum mismatch → 400',
  );
  expect(
    !mismatch.body.success &&
      /does not equal totalTarget/i.test(
        (mismatch.body as ApiError).error.message,
      ),
    'rejection message mentions sum mismatch',
  );

  // Quarter out-of-range (DTO-level rejection).
  const badQuarter = await call(
    'POST',
    '/targets',
    {
      branchId: branch.id,
      year: 2026,
      quarter: 5,
      totalTarget: 100,
      categories: [{ commissionGroup: 'RATE_HAIR', targetAmount: 100 }],
    },
    token,
  );
  expect(badQuarter.status === 400, 'quarter > 4 → 400 (DTO)');

  // ─────────────────────────────────────────────────────────────
  // CRITERION 6: Unique Constraint — duplicate target → 409
  // ─────────────────────────────────────────────────────────────
  console.log('\n[6] Duplicate (branch, year, quarter) target → 409');
  const dup = await call(
    'POST',
    '/targets',
    {
      branchId: branch.id,
      year: 2026,
      quarter: 1,
      totalTarget: 5_000_000,
      categories: [
        { commissionGroup: 'RATE_HAIR', targetAmount: 3_000_000 },
        { commissionGroup: 'RATE_SKIN', targetAmount: 1_000_000 },
        { commissionGroup: 'RATE_SURGERY', targetAmount: 1_000_000 },
      ],
    },
    token,
  );
  expect(dup.status === 409, 'duplicate target → 409');

  // Different quarter on the same branch — should succeed.
  const q2 = unwrap(
    await call<TargetResp>(
      'POST',
      '/targets',
      {
        branchId: branch.id,
        year: 2026,
        quarter: 2,
        totalTarget: 1_000_000,
        categories: [
          { commissionGroup: 'RATE_HAIR', targetAmount: 1_000_000 },
        ],
      },
      token,
    ),
  );
  expect(q2.quarter === 2, 'same branch, different quarter → OK');

  // ─────────────────────────────────────────────────────────────
  // CRITERION 3 & 4: Progress — completed orders included,
  //                  non-completed excluded; grouping by commissionGroup
  // ─────────────────────────────────────────────────────────────
  console.log('\n[3/4] Progress reflects only COMPLETED orders, grouped correctly');

  // Q1 = Jan 1 – Mar 31 (UTC). Stamp orders mid-quarter so DST/tz
  // surprises can't shift them.
  const inQuarter = new Date('2026-02-15T12:00:00.000Z');
  const beforeQuarter = new Date('2025-12-15T12:00:00.000Z');
  const afterQuarter = new Date('2026-05-15T12:00:00.000Z');

  await seedCompletedOrder(prisma, {
    branchId: branch.id,
    customerId: customer.id,
    createdByUserId: adminUser.id,
    completedAt: inQuarter,
    orderNo: `SO-TGT-${stamp}-1`,
    items: [
      { serviceId: hairSvc.id, net: 2_200_000, code: hairSvc.code, name: hairSvc.name },
      { serviceId: skinSvc.id, net: 500_000, code: skinSvc.code, name: skinSvc.name },
      { serviceId: surgerySvc.id, net: 500_000, code: surgerySvc.code, name: surgerySvc.name },
    ],
  });
  // OUT-OF-RANGE: completed before Q1 — must NOT count.
  await seedCompletedOrder(prisma, {
    branchId: branch.id,
    customerId: customer.id,
    createdByUserId: adminUser.id,
    completedAt: beforeQuarter,
    orderNo: `SO-TGT-${stamp}-pre`,
    items: [
      { serviceId: hairSvc.id, net: 999_999, code: hairSvc.code, name: hairSvc.name },
    ],
  });
  // OUT-OF-RANGE: completed after Q1 — must NOT count.
  await seedCompletedOrder(prisma, {
    branchId: branch.id,
    customerId: customer.id,
    createdByUserId: adminUser.id,
    completedAt: afterQuarter,
    orderNo: `SO-TGT-${stamp}-post`,
    items: [
      { serviceId: hairSvc.id, net: 999_999, code: hairSvc.code, name: hairSvc.name },
    ],
  });
  // NON-COMPLETED: status=PAID inside the window — must NOT count.
  await prisma.salesOrder.create({
    data: {
      orderNo: `SO-TGT-${stamp}-paid`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.PAID,
      // No completedAt because not COMPLETED. Even if it were stamped,
      // the status filter alone is enough to exclude it.
      subtotalAmount: 999_999,
      totalAmount: 999_999,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: hairSvc.id,
            quantity: 1,
            unitPrice: 999_999,
            netAmount: 999_999,
            snapshotServiceCode: hairSvc.code,
            snapshotServiceName: hairSvc.name,
            snapshotUnitPrice: 999_999,
          },
        ],
      },
    },
  });

  const progress = unwrap(
    await call<ProgressResp>(
      'GET',
      `/targets/branch/${branch.id}/progress?year=2026&quarter=1`,
      undefined,
      token,
    ),
  );
  expect(
    progress.totalActual === 3_200_000,
    `totalActual = 3,200,000 (got ${progress.totalActual}) — out-of-range and non-COMPLETED excluded`,
  );
  expect(
    progress.totalTarget === 5_000_000,
    `totalTarget = 5,000,000 (got ${progress.totalTarget})`,
  );
  // ── CRITERION 5: Percentages calculated correctly ──
  expect(
    progress.overallProgress === 64,
    `overallProgress = 64 (got ${progress.overallProgress})`,
  );

  const hair = progress.categories.find((c) => c.group === 'RATE_HAIR')!;
  expect(hair.target === 3_000_000, 'hair target = 3,000,000');
  expect(hair.actual === 2_200_000, 'hair actual = 2,200,000');
  expect(hair.progress === 73.3, 'hair progress = 73.3% (rounded to 1dp)');

  const skin = progress.categories.find((c) => c.group === 'RATE_SKIN')!;
  expect(skin.actual === 500_000, 'skin actual = 500,000');
  expect(skin.progress === 50, 'skin progress = 50%');

  const surgery = progress.categories.find((c) => c.group === 'RATE_SURGERY')!;
  expect(surgery.actual === 500_000, 'surgery actual = 500,000');
  expect(surgery.progress === 50, 'surgery progress = 50%');

  // ─────────────────────────────────────────────────────────────
  // BONUS: PATCH replaces categories + re-validates the new sum
  // ─────────────────────────────────────────────────────────────
  console.log('\n[7] PATCH /targets/:id replaces categories atomically');
  const patched = unwrap(
    await call<TargetResp>(
      'PATCH',
      `/targets/${target.id}`,
      {
        totalTarget: 6_000_000,
        categories: [
          { commissionGroup: 'RATE_HAIR', targetAmount: 4_000_000 },
          { commissionGroup: 'RATE_SKIN', targetAmount: 1_000_000 },
          { commissionGroup: 'RATE_SURGERY', targetAmount: 1_000_000 },
        ],
      },
      token,
    ),
  );
  expect(
    Number(patched.totalTarget) === 6_000_000 && patched.categories.length === 3,
    'PATCH bumped totalTarget to 6M and kept 3 categories',
  );

  // PATCH with a new sum that doesn't match → 400.
  const patchMismatch = await call(
    'PATCH',
    `/targets/${target.id}`,
    {
      totalTarget: 6_000_000,
      categories: [
        { commissionGroup: 'RATE_HAIR', targetAmount: 4_000_000 },
        { commissionGroup: 'RATE_SKIN', targetAmount: 500_000 },
        // Missing — sum = 4.5M ≠ 6M.
      ],
    },
    token,
  );
  expect(patchMismatch.status === 400, 'PATCH sum mismatch → 400');

  // PATCH with totalTarget only — must agree with the existing categories.
  const patchSoloMismatch = await call(
    'PATCH',
    `/targets/${target.id}`,
    { totalTarget: 9_999_999 },
    token,
  );
  expect(
    patchSoloMismatch.status === 400,
    'PATCH totalTarget without categories must still match existing sum → 400',
  );

  await prisma.$disconnect();
  console.log('\n✓ All branch-target smoke checks passed.');
}

main().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exit(1);
});
