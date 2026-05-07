/**
 * Smoke for the OpenedContainers module.
 *
 * Setup (direct DB):
 *  - Locate or create: warehouse, partial-strategy stock item (BTX-100U), a fresh
 *    stock lot with quantityOnHand >= 3.
 *  - Locate or create: a service event in IN_PROGRESS state for an existing
 *    customer + service + appointment + sales order chain.
 *
 * API exercises:
 *  1. POST /opened-containers (open)        → 201, lot deducted by 1, container ACTIVE
 *  2. POST /opened-containers/:id/use       → remaining decreases
 *  3. POST /opened-containers/:id/use (drain) → status becomes EMPTY
 *  4. POST /opened-containers/:id/use (after EMPTY) → 409 (not ACTIVE)
 *  5. POST /opened-containers (open second)
 *  6. PATCH /opened-containers/:id/discard  → DISCARDED + DISCARD movement
 *  7. POST /opened-containers (open third)
 *  8. PATCH /opened-containers/:id/expire   → EXPIRED
 *  9. GET /opened-containers?status=ACTIVE
 * 10. GET /opened-containers?stockLotId=...
 * 11. Negative: open against WHOLE_ONLY item → 400
 *
 * Direct-DB asserts: ServiceStockUsage row written; StockMovement(CLINICAL_USAGE)
 * with delta=-1 created at open; StockMovement(DISCARD) created at discard; lot
 * quantityOnHand decremented exactly by the number of opens.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AppointmentStatus,
  ConsumptionStrategy,
  PrismaClient,
  SalesOrderStatus,
  ServiceEventStatus,
  StockMovementType,
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
  const json = (await res.json()) as ApiResponse<T>;
  return { status: res.status, body: json };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok   ${msg}`);
}

const decToNum = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v));
};

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });

  // ── Step A: locate / bootstrap a properly-configured partial-strategy item ──
  let stockItem = await prisma.stockItem.findFirst({
    where: {
      consumptionStrategy: {
        in: [
          ConsumptionStrategy.PARTIAL_ALLOWED,
          ConsumptionStrategy.PARTIAL_REQUIRED,
        ],
      },
      conversionFactor: { not: null },
      secondaryUnitId: { not: null },
      isActive: true,
      deletedAt: null,
    },
  });
  if (!stockItem) {
    // Attach a secondary unit + conversionFactor=100 to the seeded BTX vial.
    const target = await prisma.stockItem.findFirst({
      where: {
        consumptionStrategy: {
          in: [
            ConsumptionStrategy.PARTIAL_ALLOWED,
            ConsumptionStrategy.PARTIAL_REQUIRED,
          ],
        },
        isActive: true,
        deletedAt: null,
      },
    });
    if (!target)
      throw new Error(
        'No partial-strategy stock item exists at all to bootstrap',
      );
    const secondaryUnit = await prisma.unit.findFirst({
      where: { isActive: true, NOT: { id: target.primaryUnitId } },
    });
    if (!secondaryUnit)
      throw new Error('Need a second active unit to attach as secondaryUnit');
    stockItem = await prisma.stockItem.update({
      where: { id: target.id },
      data: { secondaryUnitId: secondaryUnit.id, conversionFactor: 100 },
    });
    console.log(
      `Bootstrapped ${stockItem.sku} with secondaryUnit=${secondaryUnit.code} conversionFactor=100`,
    );
  }
  if (!stockItem.conversionFactor)
    throw new Error('stockItem.conversionFactor is null after bootstrap');
  const conversionFactor = decToNum(stockItem.conversionFactor);
  console.log(
    `stockItem=${stockItem.sku} strategy=${stockItem.consumptionStrategy} conv=${conversionFactor}`,
  );

  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
  });
  if (!warehouse) throw new Error('No active warehouse');

  // Fresh lot for this run with on-hand 5
  const stamp = Date.now().toString().slice(-6);
  const lot = await prisma.stockLot.create({
    data: {
      stockItemId: stockItem.id,
      warehouseId: warehouse.id,
      lotCode: `OC-LOT-${stamp}`,
      quantityReceived: 5,
      quantityOnHand: 5,
      unitCost: 1,
    },
  });
  console.log(`Fresh lot ${lot.lotCode} on-hand=5`);

  // Service event in IN_PROGRESS — try to find or create the chain
  let event = await prisma.customerServiceEvent.findFirst({
    where: { status: ServiceEventStatus.IN_PROGRESS },
  });
  if (!event) {
    const adminUser = await prisma.user.findFirst({
      where: { email: 'admin@reverie.local' },
    });
    if (!adminUser) throw new Error('admin user missing');

    const order = await prisma.salesOrder.findFirst({
      where: {
        status: {
          in: [
            SalesOrderStatus.CONFIRMED,
            SalesOrderStatus.PAID,
            SalesOrderStatus.PARTIALLY_PAID,
          ],
        },
      },
      include: { items: { take: 1 } },
    });
    if (!order || order.items.length === 0) {
      throw new Error(
        'Need at least one CONFIRMED/PAID SalesOrder with items to seed a service event',
      );
    }
    const item = order.items[0];

    let appt = await prisma.appointment.findFirst({
      where: { salesOrderId: order.id, status: AppointmentStatus.CHECKED_IN },
    });
    if (!appt) {
      const last = await prisma.appointment.findFirst({
        where: { appointmentNo: { startsWith: 'APT-' } },
        orderBy: { appointmentNo: 'desc' },
      });
      const nextSeq = last ? parseInt(last.appointmentNo.slice(-4), 10) + 1 : 1;
      const today = new Date();
      const yyyymmdd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
      appt = await prisma.appointment.create({
        data: {
          appointmentNo: `APT-${yyyymmdd}-${String(nextSeq).padStart(4, '0')}`,
          customer: { connect: { id: order.customerId } },
          salesOrder: { connect: { id: order.id } },
          service: { connect: { id: item.serviceId } },
          branch: { connect: { id: order.branchId } },
          createdBy: { connect: { id: adminUser.id } },
          scheduledAt: new Date(),
          status: AppointmentStatus.CHECKED_IN,
          checkedInAt: new Date(),
        },
      });
    }
    event = await prisma.customerServiceEvent.create({
      data: {
        customer: { connect: { id: order.customerId } },
        branch: { connect: { id: order.branchId } },
        service: { connect: { id: item.serviceId } },
        salesOrder: { connect: { id: order.id } },
        appointment: { connect: { id: appt.id } },
        performedAt: new Date(),
        status: ServiceEventStatus.IN_PROGRESS,
      },
    });
  }
  console.log(`Using event ${event.id} (service=${event.serviceId})`);

  // ── Step B: login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = (login.body as ApiSuccess<{ accessToken: string }>).data
    .accessToken;

  // ── 1. Open container #1 ──
  const open1 = await call<{
    id: string;
    initialQtyPrimary: string;
    remainingQtyPrimary: string;
    status: string;
  }>(
    'POST',
    '/opened-containers',
    { stockLotId: lot.id, note: 'Smoke vial #1' },
    token,
  );
  expect(open1.status === 201, 'POST /opened-containers returns 201');
  const c1 = (
    open1.body as ApiSuccess<{
      id: string;
      initialQtyPrimary: string;
      remainingQtyPrimary: string;
      status: string;
    }>
  ).data;
  expect(
    decToNum(c1.initialQtyPrimary) === conversionFactor,
    `initialQtyPrimary = conversionFactor (${conversionFactor})`,
  );
  expect(
    decToNum(c1.remainingQtyPrimary) === conversionFactor,
    'remainingQtyPrimary = initial',
  );
  expect(c1.status === 'ACTIVE', 'container status ACTIVE');

  const lotAfterOpen1 = await prisma.stockLot.findUnique({
    where: { id: lot.id },
  });
  expect(
    decToNum(lotAfterOpen1!.quantityOnHand) === 4,
    'lot.quantityOnHand decremented to 4 after first open',
  );

  const openMovement = await prisma.stockMovement.findFirst({
    where: {
      stockLotId: lot.id,
      type: StockMovementType.CLINICAL_USAGE,
      referenceId: c1.id,
    },
  });
  expect(openMovement !== null, 'CLINICAL_USAGE movement created at open');
  expect(
    decToNum(openMovement!.quantityDelta) === -1,
    'movement.quantityDelta = -1',
  );

  // ── 2. Use a portion ──
  const useAmt1 = Math.min(20, conversionFactor / 2);
  const use1 = await call<{ remainingQtyPrimary: string; status: string }>(
    'POST',
    `/opened-containers/${c1.id}/use`,
    {
      customerServiceEventId: event.id,
      serviceId: event.serviceId,
      quantityPrimaryUsed: useAmt1,
    },
    token,
  );
  expect(use1.status === 200, 'POST /:id/use returns 200');
  const afterUse1 = (
    use1.body as ApiSuccess<{ remainingQtyPrimary: string; status: string }>
  ).data;
  expect(
    decToNum(afterUse1.remainingQtyPrimary) === conversionFactor - useAmt1,
    'remaining = initial - used',
  );
  expect(afterUse1.status === 'ACTIVE', 'still ACTIVE after partial use');

  // ── 3. Drain container ──
  const remaining = decToNum(afterUse1.remainingQtyPrimary);
  const use2 = await call<{ remainingQtyPrimary: string; status: string }>(
    'POST',
    `/opened-containers/${c1.id}/use`,
    {
      customerServiceEventId: event.id,
      serviceId: event.serviceId,
      quantityPrimaryUsed: remaining,
    },
    token,
  );
  expect(use2.status === 200, 'final draining use returns 200');
  const drained = (
    use2.body as ApiSuccess<{ remainingQtyPrimary: string; status: string }>
  ).data;
  expect(
    decToNum(drained.remainingQtyPrimary) === 0,
    'remaining = 0 after drain',
  );
  expect(drained.status === 'EMPTY', 'status flips to EMPTY at remaining=0');

  // ── 4. Use after EMPTY → 409 ──
  const useAfterEmpty = await call(
    'POST',
    `/opened-containers/${c1.id}/use`,
    {
      customerServiceEventId: event.id,
      serviceId: event.serviceId,
      quantityPrimaryUsed: 1,
    },
    token,
  );
  expect(useAfterEmpty.status === 409, 'use against EMPTY container → 409');

  // ── 5. Open container #2 ──
  const open2 = await call<{ id: string }>(
    'POST',
    '/opened-containers',
    { stockLotId: lot.id },
    token,
  );
  expect(open2.status === 201, 'open second container returns 201');
  const c2 = (open2.body as ApiSuccess<{ id: string }>).data;

  // ── 6. Discard ──
  const discard = await call<{ status: string }>(
    'PATCH',
    `/opened-containers/${c2.id}/discard`,
    { reason: 'Contamination during smoke test' },
    token,
  );
  expect(discard.status === 200, 'discard returns 200');
  expect(
    (discard.body as ApiSuccess<{ status: string }>).data.status ===
      'DISCARDED',
    'status = DISCARDED after discard',
  );
  const discardMv = await prisma.stockMovement.findFirst({
    where: { type: StockMovementType.DISCARD, referenceId: c2.id },
  });
  expect(discardMv !== null, 'DISCARD movement created');
  expect(
    decToNum(discardMv!.quantityDelta) === 0,
    'DISCARD movement quantityDelta = 0 (lot already deducted at open)',
  );

  // discard idempotency: discarding again should 409
  const dupDiscard = await call(
    'PATCH',
    `/opened-containers/${c2.id}/discard`,
    {},
    token,
  );
  expect(dupDiscard.status === 409, 'second discard → 409');

  // ── 7. Open container #3, then expire ──
  const open3 = await call<{ id: string }>(
    'POST',
    '/opened-containers',
    { stockLotId: lot.id },
    token,
  );
  expect(open3.status === 201, 'open third container');
  const c3 = (open3.body as ApiSuccess<{ id: string }>).data;
  const expire = await call<{ status: string }>(
    'PATCH',
    `/opened-containers/${c3.id}/expire`,
    { reason: 'Past in-use shelf life' },
    token,
  );
  expect(expire.status === 200, 'expire returns 200');
  expect(
    (expire.body as ApiSuccess<{ status: string }>).data.status === 'EXPIRED',
    'status = EXPIRED after expire',
  );

  // ── 8. Verify lot deducted by exactly 3 (three opens) ──
  const lotFinal = await prisma.stockLot.findUnique({ where: { id: lot.id } });
  expect(
    decToNum(lotFinal!.quantityOnHand) === 5 - 3,
    'lot.quantityOnHand = initial(5) - 3 opens = 2',
  );

  // ── 9. ServiceStockUsage rows linked to container c1 ──
  const usages = await prisma.serviceStockUsage.findMany({
    where: { openedContainerId: c1.id },
    orderBy: { createdAt: 'asc' },
  });
  expect(usages.length === 2, 'two ServiceStockUsage rows on container #1');
  const totalUsed = usages.reduce(
    (acc, u) => acc + decToNum(u.quantityPrimaryUsed),
    0,
  );
  expect(
    totalUsed === conversionFactor,
    `usages sum to conversionFactor (${conversionFactor})`,
  );

  // ── 10. Filters ──
  const listActive = await call<{
    data: Array<{ id: string; status: string }>;
  }>(
    'GET',
    `/opened-containers?status=ACTIVE&stockLotId=${lot.id}`,
    undefined,
    token,
  );
  expect(
    (
      listActive.body as ApiSuccess<{
        data: Array<{ id: string; status: string }>;
      }>
    ).data.data.every((c) => c.status === 'ACTIVE'),
    'GET ?status=ACTIVE only returns ACTIVE rows',
  );

  const listByLot = await call<{ data: Array<{ id: string }> }>(
    'GET',
    `/opened-containers?stockLotId=${lot.id}`,
    undefined,
    token,
  );
  const lotRows = (
    listByLot.body as ApiSuccess<{ data: Array<{ id: string }> }>
  ).data.data;
  expect(
    lotRows.length >= 3,
    'GET ?stockLotId returns the three containers we opened',
  );
  expect(
    [c1.id, c2.id, c3.id].every((id) => lotRows.some((r) => r.id === id)),
    'all three containers present in lot-scoped listing',
  );

  // ── 11. Negative: open against a WHOLE_ONLY item ──
  const wholeItem = await prisma.stockItem.findFirst({
    where: {
      consumptionStrategy: ConsumptionStrategy.WHOLE_ONLY,
      isActive: true,
      deletedAt: null,
    },
  });
  if (!wholeItem) {
    console.log(
      '  skip WHOLE_ONLY negative test (no whole-only stock item seeded)',
    );
  } else {
    let wholeLot = await prisma.stockLot.findFirst({
      where: {
        stockItemId: wholeItem.id,
        status: 'ACTIVE',
        quantityOnHand: { gt: 0 },
      },
    });
    if (!wholeLot) {
      wholeLot = await prisma.stockLot.create({
        data: {
          stockItemId: wholeItem.id,
          warehouseId: warehouse.id,
          lotCode: `OC-WHOLE-${stamp}`,
          quantityReceived: 1,
          quantityOnHand: 1,
          unitCost: 0,
        },
      });
    }
    const reject = await call(
      'POST',
      '/opened-containers',
      { stockLotId: wholeLot.id },
      token,
    );
    expect(reject.status === 400, 'open against WHOLE_ONLY item → 400');
  }

  await prisma.$disconnect();
  console.log('\nALL OPENED-CONTAINER SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
