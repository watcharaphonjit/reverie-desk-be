/**
 * Smoke for the treatment-entitlement (session-based program) module.
 *
 * Walks every Success Criterion in the spec:
 *   ✓ Purchase: paying a SO with a 7-session program mints an entitlement
 *               with total=7, consumed=0
 *   ✓ Booking:  POST /appointments with entitlementId is accepted
 *   ✓ Completion: completing the appointment increments consumed to 1,
 *               remaining drops to 6
 *   ✓ Limit:    after 7 completions the 8th consume is rejected
 *   ✓ Multi-Quantity: paying a SO with quantity=2 of a 7-session program
 *               mints total=14
 *   ✓ Customer API: GET /customers/:id/entitlements returns accurate
 *               remainingSessions
 *
 * Plus rejection paths:
 *   ✓ Booking with an entitlement for the wrong customer → 403
 *   ✓ Booking with an entitlement for the wrong service → 400
 *   ✓ Booking against an EXPIRED entitlement → 400
 *   ✓ Consume on a CANCELLED appointment → 400
 *   ✓ /consume is idempotent (second call no-ops, returns same view)
 *
 * Run: BASE_URL=http://localhost:3000/api/v1 tsx scripts/smoke-treatment-entitlements.ts
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, SalesOrderStatus } from '@prisma/client';

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

interface EntitlementResp {
  id: string;
  customerId: string;
  serviceId: string;
  serviceName: string;
  totalSessions: number;
  consumedSessions: number;
  remainingSessions: number;
  expiredAt: string | null;
  isExpired: boolean;
}
interface AppointmentResp {
  id: string;
  status: string;
  branchId: string;
  customerId: string;
  serviceId: string;
  entitlementId?: string | null;
  entitlementConsumedAt?: string | null;
}

async function recordServiceEvent(
  prisma: PrismaClient,
  args: {
    appointmentId: string;
    branchId: string;
    customerId: string;
    serviceId: string;
    actorUserId: string;
  },
): Promise<void> {
  // Hand-roll a service event directly so the smoke is independent of
  // the service-events HTTP module. The /complete guard only checks
  // existence, not which user wrote it.
  await prisma.customerServiceEvent.create({
    data: {
      branchId: args.branchId,
      customerId: args.customerId,
      serviceId: args.serviceId,
      appointmentId: args.appointmentId,
      performedAt: new Date(),
      completedAt: new Date(),
      employeeUserId: args.actorUserId,
      status: 'COMPLETED',
    },
  });
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-7);

  // ── Bootstrap ──
  const branch = await prisma.branch.findFirst({ where: { status: 'ACTIVE' } });
  if (!branch) throw new Error('Need an active branch');
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  if (!adminUser) throw new Error('Need admin user (run seed)');

  // Two distinct customers — one for the happy path, one for the
  // wrong-customer rejection test.
  const customer = await prisma.customer.create({
    data: {
      code: `CUST-ENT-${stamp}`,
      fullName: `Entitlement Test ${stamp}`,
      currentBranchId: branch.id,
    },
  });
  const otherCustomer = await prisma.customer.create({
    data: {
      code: `CUST-ENT-OTH-${stamp}`,
      fullName: `Other Test ${stamp}`,
      currentBranchId: branch.id,
    },
  });

  // Two distinct program services, plus one non-program for negatives.
  const hairProgram = await prisma.service.create({
    data: {
      code: `SVC-HAIR-PRG-${stamp}`,
      name: `Hair Growth Program (${stamp})`,
      basePrice: 10_000,
      isProgram: true,
      defaultSessions: 7,
      isActive: true,
    },
  });
  const acneProgram = await prisma.service.create({
    data: {
      code: `SVC-ACNE-PRG-${stamp}`,
      name: `Acne Program (${stamp})`,
      basePrice: 5_000,
      isProgram: true,
      defaultSessions: 5,
      isActive: true,
    },
  });

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ─────────────────────────────────────────────────────────────
  // CRITERION 1: Purchase — buy 1 Hair Program (7 sessions) →
  // entitlement minted with total=7, consumed=0
  // ─────────────────────────────────────────────────────────────
  console.log('\n[1] Purchase mints entitlement on transition to PAID');
  const order1 = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-ENT1-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 10_000,
      totalAmount: 10_000,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: hairProgram.id,
            quantity: 1,
            unitPrice: 10_000,
            netAmount: 10_000,
            snapshotServiceCode: hairProgram.code,
            snapshotServiceName: hairProgram.name,
            snapshotUnitPrice: 10_000,
          },
        ],
      },
    },
  });
  // Pay in full via API → triggers PAID transition → mints entitlement.
  unwrap(
    await call(
      'POST',
      '/payments',
      {
        salesOrderId: order1.id,
        amount: 10_000,
        paymentMethod: 'CASH',
        paymentType: 'FULL',
      },
      token,
    ),
  );
  const ents1 = unwrap(
    await call<EntitlementResp[]>(
      'GET',
      `/customers/${customer.id}/entitlements`,
      undefined,
      token,
    ),
  );
  expect(ents1.length === 1, '1 entitlement minted for the paid order');
  const ent1 = ents1[0];
  expect(ent1.totalSessions === 7, 'totalSessions = 7');
  expect(ent1.consumedSessions === 0, 'consumedSessions = 0');
  expect(ent1.remainingSessions === 7, 'remainingSessions = 7');
  expect(ent1.serviceId === hairProgram.id, 'serviceId matches the program');

  // Idempotency: a second payment-of-zero would re-trigger the engine?
  // We can verify by re-firing /payments would reject (already PAID); a
  // simpler check: re-fetch and confirm still exactly one row.
  const ents1again = unwrap(
    await call<EntitlementResp[]>(
      'GET',
      `/customers/${customer.id}/entitlements`,
      undefined,
      token,
    ),
  );
  expect(ents1again.length === 1, 'no duplicate mint on subsequent reads');

  // ─────────────────────────────────────────────────────────────
  // CRITERION 2 & 3: Book against entitlement, complete, consume = 1
  // ─────────────────────────────────────────────────────────────
  console.log('\n[2/3] Book + complete consumes one session');
  const book = unwrap(
    await call<AppointmentResp>(
      'POST',
      '/appointments',
      {
        salesOrderId: order1.id,
        customerId: customer.id,
        serviceId: hairProgram.id,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        entitlementId: ent1.id,
      },
      token,
    ),
  );
  expect(book.entitlementId === ent1.id, 'appointment carries entitlementId');
  unwrap(
    await call('PATCH', `/appointments/${book.id}/check-in`, {}, token),
  );
  await recordServiceEvent(prisma, {
    appointmentId: book.id,
    branchId: branch.id,
    customerId: customer.id,
    serviceId: hairProgram.id,
    actorUserId: adminUser.id,
  });
  const completed = unwrap(
    await call<AppointmentResp>(
      'PATCH',
      `/appointments/${book.id}/complete`,
      {},
      token,
    ),
  );
  expect(completed.status === 'COMPLETED', 'appointment is COMPLETED');
  const after1 = unwrap(
    await call<EntitlementResp>(
      'GET',
      `/entitlements/${ent1.id}`,
      undefined,
      token,
    ),
  );
  expect(after1.consumedSessions === 1, 'consumedSessions = 1');
  expect(after1.remainingSessions === 6, 'remainingSessions = 6');

  // Idempotency: explicit /consume on the same appointment is a no-op.
  const idem = unwrap(
    await call<EntitlementResp>(
      'POST',
      `/appointments/${book.id}/consume`,
      {},
      token,
    ),
  );
  expect(idem.consumedSessions === 1, 'second /consume is idempotent');

  // ─────────────────────────────────────────────────────────────
  // CRITERION 4: Limit — after 7 completions, the 8th must fail
  // ─────────────────────────────────────────────────────────────
  console.log('\n[4] Burn through remaining sessions; 8th must fail');
  // Burn sessions 2..7 (we already used 1 above).
  for (let i = 2; i <= 7; i++) {
    const appt = unwrap(
      await call<AppointmentResp>(
        'POST',
        '/appointments',
        {
          salesOrderId: order1.id,
          customerId: customer.id,
          serviceId: hairProgram.id,
          scheduledAt: new Date(
            Date.now() + (i + 1) * 60 * 60 * 1000,
          ).toISOString(),
          entitlementId: ent1.id,
        },
        token,
      ),
    );
    unwrap(
      await call('PATCH', `/appointments/${appt.id}/check-in`, {}, token),
    );
    await recordServiceEvent(prisma, {
      appointmentId: appt.id,
      branchId: branch.id,
      customerId: customer.id,
      serviceId: hairProgram.id,
      actorUserId: adminUser.id,
    });
    unwrap(
      await call('PATCH', `/appointments/${appt.id}/complete`, {}, token),
    );
  }
  const exhausted = unwrap(
    await call<EntitlementResp>(
      'GET',
      `/entitlements/${ent1.id}`,
      undefined,
      token,
    ),
  );
  expect(
    exhausted.consumedSessions === 7 && exhausted.remainingSessions === 0,
    '7/7 consumed, 0 remaining',
  );

  // Try to book the 8th — must fail (assertBookable EXHAUSTED).
  const bookEighth = await call(
    'POST',
    '/appointments',
    {
      salesOrderId: order1.id,
      customerId: customer.id,
      serviceId: hairProgram.id,
      scheduledAt: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(),
      entitlementId: ent1.id,
    },
    token,
  );
  expect(
    !bookEighth.body.success && bookEighth.status >= 400 && bookEighth.status < 500,
    '8th booking rejected (entitlement exhausted)',
  );

  // ─────────────────────────────────────────────────────────────
  // CRITERION 5: Multi-quantity — qty=2 of a 7-session program → 14
  // ─────────────────────────────────────────────────────────────
  console.log('\n[5] Multi-quantity → totalSessions = qty * defaultSessions');
  const order2 = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-ENT2-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 20_000,
      totalAmount: 20_000,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: hairProgram.id,
            quantity: 2,
            unitPrice: 10_000,
            netAmount: 20_000,
            snapshotServiceCode: hairProgram.code,
            snapshotServiceName: hairProgram.name,
            snapshotUnitPrice: 10_000,
          },
        ],
      },
    },
  });
  unwrap(
    await call(
      'POST',
      '/payments',
      {
        salesOrderId: order2.id,
        amount: 20_000,
        paymentMethod: 'CASH',
        paymentType: 'FULL',
      },
      token,
    ),
  );
  const ents2 = unwrap(
    await call<EntitlementResp[]>(
      'GET',
      `/customers/${customer.id}/entitlements`,
      undefined,
      token,
    ),
  );
  // We now expect 2 entitlements: the original 7/7-exhausted one and
  // a new 14-session one for qty=2.
  expect(
    ents2.length === 2,
    '2 entitlements visible (the exhausted one + the new multi-qty one)',
  );
  const multiQty = ents2.find(
    (e) => e.totalSessions === 14 && e.consumedSessions === 0,
  );
  expect(!!multiQty, 'multi-qty entitlement totalSessions = 14');

  // ─────────────────────────────────────────────────────────────
  // Rejection paths
  // ─────────────────────────────────────────────────────────────
  console.log('\n[R] Validation rejection paths');

  // Book with the WRONG customer's entitlement against an order that
  // belongs to `otherCustomer`.
  const otherOrder = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-ENT-OTH-${stamp}`,
      branchId: branch.id,
      customerId: otherCustomer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 100,
      totalAmount: 100,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: hairProgram.id,
            quantity: 1,
            unitPrice: 100,
            netAmount: 100,
            snapshotServiceCode: hairProgram.code,
            snapshotServiceName: hairProgram.name,
            snapshotUnitPrice: 100,
          },
        ],
      },
    },
  });
  const wrongCust = await call(
    'POST',
    '/appointments',
    {
      salesOrderId: otherOrder.id,
      customerId: otherCustomer.id,
      serviceId: hairProgram.id,
      scheduledAt: new Date(Date.now() + 100 * 60 * 60 * 1000).toISOString(),
      entitlementId: multiQty!.id,
    },
    token,
  );
  expect(
    !wrongCust.body.success && wrongCust.status === 403,
    'booking with another customer\'s entitlement → 403',
  );

  // Book with a wrong-service entitlement: use the multi-qty (Hair) ent
  // for an order whose item is the Acne program.
  const acneOrder = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-ENT-ACNE-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 5_000,
      totalAmount: 5_000,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: acneProgram.id,
            quantity: 1,
            unitPrice: 5_000,
            netAmount: 5_000,
            snapshotServiceCode: acneProgram.code,
            snapshotServiceName: acneProgram.name,
            snapshotUnitPrice: 5_000,
          },
        ],
      },
    },
  });
  const wrongSvc = await call(
    'POST',
    '/appointments',
    {
      salesOrderId: acneOrder.id,
      customerId: customer.id,
      serviceId: acneProgram.id,
      scheduledAt: new Date(Date.now() + 110 * 60 * 60 * 1000).toISOString(),
      entitlementId: multiQty!.id,
    },
    token,
  );
  expect(
    !wrongSvc.body.success && wrongSvc.status === 400,
    'booking with wrong-service entitlement → 400',
  );

  // Expire endpoint + post-expire booking rejection.
  const expired = unwrap(
    await call<EntitlementResp>(
      'PATCH',
      `/entitlements/${multiQty!.id}/expire`,
      { reason: 'smoke test expiration' },
      token,
    ),
  );
  expect(
    expired.expiredAt !== null && expired.isExpired,
    'PATCH /entitlements/:id/expire stamps expiredAt + isExpired',
  );
  // Idempotent: calling expire again returns the same row.
  const expiredAgain = unwrap(
    await call<EntitlementResp>(
      'PATCH',
      `/entitlements/${multiQty!.id}/expire`,
      {},
      token,
    ),
  );
  expect(
    expiredAgain.id === expired.id && expiredAgain.isExpired,
    'expire is idempotent',
  );
  // Booking against an expired entitlement → 400.
  const bookExpired = await call(
    'POST',
    '/appointments',
    {
      salesOrderId: order2.id,
      customerId: customer.id,
      serviceId: hairProgram.id,
      scheduledAt: new Date(Date.now() + 120 * 60 * 60 * 1000).toISOString(),
      entitlementId: multiQty!.id,
    },
    token,
  );
  expect(
    !bookExpired.body.success && bookExpired.status === 400,
    'booking with expired entitlement → 400',
  );

  // Consume on a CANCELLED appointment is rejected. Mint a fresh
  // entitlement for the otherCustomer to test against (we have the
  // orderOther already paid? No, not yet — pay it now).
  unwrap(
    await call(
      'POST',
      '/payments',
      {
        salesOrderId: otherOrder.id,
        amount: 100,
        paymentMethod: 'CASH',
        paymentType: 'FULL',
      },
      token,
    ),
  );
  const otherEnts = unwrap(
    await call<EntitlementResp[]>(
      'GET',
      `/customers/${otherCustomer.id}/entitlements`,
      undefined,
      token,
    ),
  );
  expect(
    otherEnts.length >= 1,
    'otherCustomer has at least 1 entitlement after paying',
  );
  const otherEnt = otherEnts.find((e) => e.consumedSessions === 0)!;
  const cancelledAppt = unwrap(
    await call<AppointmentResp>(
      'POST',
      '/appointments',
      {
        salesOrderId: otherOrder.id,
        customerId: otherCustomer.id,
        serviceId: hairProgram.id,
        scheduledAt: new Date(Date.now() + 130 * 60 * 60 * 1000).toISOString(),
        entitlementId: otherEnt.id,
      },
      token,
    ),
  );
  unwrap(
    await call('PATCH', `/appointments/${cancelledAppt.id}/cancel`, {}, token),
  );
  const consumeCancelled = await call(
    'POST',
    `/appointments/${cancelledAppt.id}/consume`,
    {},
    token,
  );
  expect(
    !consumeCancelled.body.success && consumeCancelled.status === 400,
    'consume on a CANCELLED appointment → 400',
  );

  // ── Cleanup is left to the test DB rotation; entitlements + their
  // appointments will be cascade-deleted with the customers if needed.

  console.log(
    '\n✓ All treatment-entitlement smoke checks passed. Run finished cleanly.',
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exit(1);
});
