/**
 * Smoke for the spec-alignment gaps closed in the clinical-flow audit:
 *   1. GET /appointments/:id detail includes service events.
 *   2. PATCH /appointments/:id/complete rejects when no service event exists.
 *   3. PATCH /appointments/:id/cancel rejects from CHECKED_IN (BOOKED only).
 *   4. POST /service-events accepts walk-ins (no appointmentId) and rejects
 *      mismatched branchId/customerId/serviceId vs. the appointment.
 *   5. WHOLE_ONLY consumption strategy rejects fractional quantities.
 *   6. POST /opened-containers/open route alias works AND validates the
 *      optional explicit cross-check fields.
 *   7. POST /service-events/:id/stock-usage route alias works.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConsumptionStrategy,
  PrismaClient,
  SalesOrderStatus,
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
const decToNum = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v));
};

interface AppointmentResp {
  id: string;
  appointmentNo: string;
  status: string;
  branchId: string;
  customerId: string;
  serviceId: string;
  serviceEvents?: Array<{ id: string; status: string }>;
}
interface ServiceEventResp {
  id: string;
  customerId: string;
  serviceId: string;
  branchId: string;
  appointmentId: string | null;
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
  const service = await prisma.service.findFirst({
    where: { isActive: true, deletedAt: null },
  });
  if (!service) throw new Error('Need an active service');

  // SalesOrder must reference this service so the appointment-create guard
  // ("service is part of the sales order") can pass. We hand-roll one
  // straight via Prisma so the smoke remains independent of the SO module.
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  if (!adminUser) throw new Error('Need admin user (run seed)');

  const order = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-CLIN-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 100,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 100,
      depositRequired: 0,
      items: {
        create: [
          {
            serviceId: service.id,
            quantity: 1,
            unitPrice: 100,
            discountAmount: 0,
            netAmount: 100,
            snapshotServiceCode: service.code,
            snapshotServiceName: service.name,
            snapshotUnitPrice: 100,
          },
        ],
      },
    },
  });

  // Warehouse + sellable WHOLE_ONLY stock item + lot for stock-usage tests.
  const warehouse = await prisma.warehouse.findFirst({
    where: { branchId: branch.id, isActive: true },
  });
  if (!warehouse) throw new Error('Need a branch warehouse');
  const unit = await prisma.unit.findFirst({ where: { isActive: true } });
  if (!unit) throw new Error('Need a unit');

  const wholeItem = await prisma.stockItem.create({
    data: {
      sku: `CLIN-WHOLE-${stamp}`,
      name: `Whole-only test ${stamp}`,
      type: 'CLINICAL',
      isSellable: false,
      isActive: true,
      consumptionStrategy: ConsumptionStrategy.WHOLE_ONLY,
      primaryUnitId: unit.id,
    },
  });
  const wholeLot = await prisma.stockLot.create({
    data: {
      stockItemId: wholeItem.id,
      warehouseId: warehouse.id,
      lotCode: `CLIN-WHOLE-LOT-${stamp}`,
      quantityReceived: 10,
      quantityOnHand: 10,
      unitCost: 1,
    },
  });

  // PARTIAL_ALLOWED stock item (with secondary unit + conversionFactor) for
  // the OpenedContainer route-alias test.
  const secondaryUnit = await prisma.unit.findFirst({
    where: { code: 'BOX', isActive: true },
  });
  const partialItem = secondaryUnit
    ? await prisma.stockItem.create({
        data: {
          sku: `CLIN-PART-${stamp}`,
          name: `Partial-allowed test ${stamp}`,
          type: 'CLINICAL',
          isSellable: false,
          isActive: true,
          consumptionStrategy: ConsumptionStrategy.PARTIAL_ALLOWED,
          primaryUnitId: unit.id,
          secondaryUnitId: secondaryUnit.id,
          conversionFactor: 100,
        },
      })
    : null;
  const partialLot = partialItem
    ? await prisma.stockLot.create({
        data: {
          stockItemId: partialItem.id,
          warehouseId: warehouse.id,
          lotCode: `CLIN-PART-LOT-${stamp}`,
          quantityReceived: 5,
          quantityOnHand: 5,
          unitCost: 1,
        },
      })
    : null;

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ── 1. GET /appointments/:id includes service events ──
  const appt1 = unwrap(
    await call<AppointmentResp>(
      'POST',
      '/appointments',
      {
        salesOrderId: order.id,
        customerId: customer.id,
        serviceId: service.id,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      token,
    ),
  );
  const apptDetail = unwrap(
    await call<AppointmentResp>(
      'GET',
      `/appointments/${appt1.id}`,
      undefined,
      token,
    ),
  );
  expect(
    Array.isArray(apptDetail.serviceEvents),
    'GET /appointments/:id payload includes serviceEvents (array)',
  );
  expect(
    apptDetail.serviceEvents!.length === 0,
    'serviceEvents starts empty for a fresh appointment',
  );

  // Check-in so we can proceed.
  unwrap(
    await call<AppointmentResp>(
      'PATCH',
      `/appointments/${appt1.id}/check-in`,
      {},
      token,
    ),
  );

  // ── 2. Complete is rejected when there are no service events linked ──
  const earlyDone = await call(
    'PATCH',
    `/appointments/${appt1.id}/complete`,
    {},
    token,
  );
  expect(
    earlyDone.status === 400 &&
      !earlyDone.body.success &&
      /service event/i.test((earlyDone.body as ApiError).error.message),
    'complete without a service event → 400',
  );

  // ── 3. Cancel from CHECKED_IN is rejected (spec: BOOKED only) ──
  const cancelChecked = await call(
    'PATCH',
    `/appointments/${appt1.id}/cancel`,
    { reason: 'spec test' },
    token,
  );
  expect(
    cancelChecked.status === 400,
    'cancel from CHECKED_IN → 400 (spec: BOOKED only)',
  );

  // Sanity: cancel from BOOKED still works on a fresh appointment.
  const appt2 = unwrap(
    await call<AppointmentResp>(
      'POST',
      '/appointments',
      {
        salesOrderId: order.id,
        customerId: customer.id,
        serviceId: service.id,
        scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
      token,
    ),
  );
  const cancelBooked = unwrap(
    await call<AppointmentResp>(
      'PATCH',
      `/appointments/${appt2.id}/cancel`,
      {},
      token,
    ),
  );
  expect(cancelBooked.status === 'CANCELLED', 'BOOKED → CANCELLED works');

  // ── 4a. Walk-in service event (no appointmentId) ──
  const walkIn = unwrap(
    await call<ServiceEventResp>(
      'POST',
      '/service-events',
      {
        customerId: customer.id,
        branchId: branch.id,
        serviceId: service.id,
      },
      token,
    ),
  );
  expect(walkIn.appointmentId === null, 'walk-in event has appointmentId=null');
  expect(walkIn.branchId === branch.id, 'walk-in branchId echoes the request');

  // ── 4b. Branch mismatch with appointment is rejected ──
  // Spin up a second branch + warehouse so we have a different branchId to
  // test the cross-check guard against.
  const otherBranch = await prisma.branch.create({
    data: { code: `OTHER-${stamp}`, name: `Other ${stamp}`, status: 'ACTIVE' },
  });
  const mismatch = await call(
    'POST',
    '/service-events',
    {
      customerId: customer.id,
      branchId: otherBranch.id,
      serviceId: service.id,
      appointmentId: appt1.id,
    },
    token,
  );
  expect(
    mismatch.status === 400,
    'service-event with branchId != appointment.branchId → 400',
  );

  // ── 4c. Appointment-bound event lands the appointmentId/salesOrderId ──
  const evt = unwrap(
    await call<ServiceEventResp>(
      'POST',
      '/service-events',
      {
        customerId: customer.id,
        branchId: branch.id,
        serviceId: service.id,
        appointmentId: appt1.id,
      },
      token,
    ),
  );
  expect(evt.appointmentId === appt1.id, 'appointment-bound event linked correctly');

  // Re-fetch the appointment detail and assert the new event shows up under
  // serviceEvents — exercises gap §1 with a non-empty array.
  const apptAfterLink = unwrap(
    await call<AppointmentResp>(
      'GET',
      `/appointments/${appt1.id}`,
      undefined,
      token,
    ),
  );
  expect(
    Array.isArray(apptAfterLink.serviceEvents) &&
      apptAfterLink.serviceEvents!.length === 1 &&
      apptAfterLink.serviceEvents![0].id === evt.id,
    'GET /appointments/:id reflects the newly-linked service event',
  );

  // ── 5. WHOLE_ONLY rejects fractional consumption ──
  const fractional = await call(
    'POST',
    `/service-events/${evt.id}/consume-stock`,
    { stockLotId: wholeLot.id, quantity: 0.5 },
    token,
  );
  expect(
    fractional.status === 400 &&
      !fractional.body.success &&
      /WHOLE_ONLY/i.test((fractional.body as ApiError).error.message),
    'WHOLE_ONLY + fractional quantity → 400',
  );

  // Sanity: integer quantity is accepted.
  unwrap(
    await call(
      'POST',
      `/service-events/${evt.id}/consume-stock`,
      { stockLotId: wholeLot.id, quantity: 1 },
      token,
    ),
  );
  const wholeLotAfter = await prisma.stockLot.findUnique({
    where: { id: wholeLot.id },
  });
  expect(
    decToNum(wholeLotAfter!.quantityOnHand) === 9,
    'WHOLE_ONLY integer consume succeeds (10 → 9)',
  );

  // ── 6. POST /opened-containers/open route alias + cross-check ──
  if (partialItem && partialLot) {
    // 6a. Cross-check: stockItemId mismatch → 400
    const ocBad = await call(
      'POST',
      '/opened-containers/open',
      {
        stockLotId: partialLot.id,
        stockItemId: 'wrong-id',
      },
      token,
    );
    expect(
      ocBad.status === 400,
      '/open: stockItemId mismatch → 400',
    );

    // 6b. Cross-check: initialQtyPrimary mismatch → 400
    const ocBadQty = await call(
      'POST',
      '/opened-containers/open',
      {
        stockLotId: partialLot.id,
        initialQtyPrimary: 1, // real conversionFactor is 100
      },
      token,
    );
    expect(
      ocBadQty.status === 400,
      '/open: initialQtyPrimary mismatch → 400',
    );

    // 6c. Open with all fields (correctly aligned) → 201
    const oc = unwrap(
      await call<{ id: string; status: string; remainingQtyPrimary: string }>(
        'POST',
        '/opened-containers/open',
        {
          stockLotId: partialLot.id,
          stockItemId: partialItem.id,
          warehouseId: warehouse.id,
          initialQtyPrimary: 100,
        },
        token,
      ),
    );
    expect(oc.status === 'ACTIVE', '/open route alias creates ACTIVE container');
    expect(
      decToNum(oc.remainingQtyPrimary) === 100,
      '/open container.remainingQtyPrimary = 100 (= conversionFactor)',
    );
  } else {
    console.log('  skip /opened-containers/open (no PARTIAL_ALLOWED + BOX seed)');
  }

  // ── 7. POST /service-events/:id/stock-usage route alias ──
  const usageAlias = await call(
    'POST',
    `/service-events/${evt.id}/stock-usage`,
    { stockLotId: wholeLot.id, quantity: 1 },
    token,
  );
  expect(
    usageAlias.status === 200,
    '/stock-usage alias accepts the same body as /consume-stock',
  );
  const wholeLotFinal = await prisma.stockLot.findUnique({
    where: { id: wholeLot.id },
  });
  expect(
    decToNum(wholeLotFinal!.quantityOnHand) === 8,
    '/stock-usage alias deducted from lot (9 → 8)',
  );

  await prisma.$disconnect();
  console.log('\nALL CLINICAL-FLOW SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
