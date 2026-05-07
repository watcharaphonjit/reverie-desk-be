/**
 * Smoke for the criteria-gap fixes in pass A + C:
 *  - Multi-item receive: POST /purchase-receipts with `items[]` creates the
 *    receipt + N lots + N PURCHASE_IN movements in one transaction.
 *  - FEFO ordering on GET /stock-lots: earliest expiry first, lots without
 *    expiry pushed to the end.
 *  - `?sort=newest` flips back to newest-first.
 *  - Stock-item `isActive` rejection on /stock-lots/receive.
 *  - PARTIAL_REQUIRED guard rejects direct service-event consume-stock.
 *  - Receive validation rolls back the whole batch on a single bad item.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConsumptionStrategy,
  PrismaClient,
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
  return { status: res.status, body: (await res.json()) as ApiResponse<T> };
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
  const stamp = Date.now().toString().slice(-6);

  const stockItem = await prisma.stockItem.findFirst({
    where: { isActive: true, deletedAt: null },
  });
  if (!stockItem) throw new Error('Need an active stock item');
  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
  });
  if (!warehouse) throw new Error('Need an active warehouse');

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = (login.body as ApiSuccess<{ accessToken: string }>).data
    .accessToken;

  // ── 1. Multi-item receive ──
  const lotA = `MULTI-A-${stamp}`;
  const lotB = `MULTI-B-${stamp}`;
  const multi = await call<{
    id: string;
    referenceNo: string;
    stockLots: Array<{ id: string; lotCode: string; quantityOnHand: string }>;
  }>(
    'POST',
    '/purchase-receipts',
    {
      warehouseId: warehouse.id,
      items: [
        {
          stockItemId: stockItem.id,
          lotCode: lotA,
          quantityReceived: 30,
          unitCost: 5,
        },
        {
          stockItemId: stockItem.id,
          lotCode: lotB,
          quantityReceived: 70,
          unitCost: 6,
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      ],
    },
    token,
  );
  expect(
    multi.status === 201,
    'multi-item POST /purchase-receipts returns 201',
  );
  const pr = (
    multi.body as ApiSuccess<{
      id: string;
      referenceNo: string;
      stockLots: Array<{ id: string; lotCode: string; quantityOnHand: string }>;
    }>
  ).data;
  expect(pr.stockLots.length === 2, 'PR includes 2 stockLots in response');
  const codes = pr.stockLots.map((l) => l.lotCode).sort();
  expect(codes[0] === lotA && codes[1] === lotB, 'both lot codes present');
  for (const l of pr.stockLots) {
    const expected = l.lotCode === lotA ? 30 : 70;
    expect(
      decToNum(l.quantityOnHand) === expected,
      `lot ${l.lotCode}.quantityOnHand = ${expected}`,
    );
  }
  // Two PURCHASE_IN movements were written, both referencing the receipt.
  const mvs = await prisma.stockMovement.findMany({
    where: {
      type: StockMovementType.PURCHASE_IN,
      referenceType: 'PURCHASE_RECEIPT',
      referenceId: pr.id,
    },
  });
  expect(mvs.length === 2, 'two PURCHASE_IN movements written');
  const totalDelta = mvs.reduce((acc, m) => acc + decToNum(m.quantityDelta), 0);
  expect(totalDelta === 100, 'sum of movement deltas = 100');

  // ── 2. Atomicity: a bad item rolls back the whole batch ──
  const badLot = `BAD-${stamp}`;
  const beforeCount = await prisma.purchaseReceipt.count();
  const bad = await call(
    'POST',
    '/purchase-receipts',
    {
      warehouseId: warehouse.id,
      items: [
        {
          stockItemId: stockItem.id,
          lotCode: badLot,
          quantityReceived: 10,
          unitCost: 1,
        },
        {
          stockItemId: 'does-not-exist',
          lotCode: `${badLot}-X`,
          quantityReceived: 1,
          unitCost: 1,
        },
      ],
    },
    token,
  );
  expect(bad.status === 400, 'bad item rejected with 400');
  const afterCount = await prisma.purchaseReceipt.count();
  expect(afterCount === beforeCount, 'no PR was committed (full rollback)');
  const orphanLot = await prisma.stockLot.findFirst({
    where: { lotCode: badLot },
  });
  expect(orphanLot === null, 'first item was rolled back too — no orphan lot');

  // ── 3. Intra-batch lotCode collision in same warehouse → 409 ──
  const coll = await call(
    'POST',
    '/purchase-receipts',
    {
      warehouseId: warehouse.id,
      items: [
        {
          stockItemId: stockItem.id,
          lotCode: `COLL-${stamp}`,
          quantityReceived: 1,
          unitCost: 1,
        },
        {
          stockItemId: stockItem.id,
          lotCode: `COLL-${stamp}`,
          quantityReceived: 1,
          unitCost: 1,
        },
      ],
    },
    token,
  );
  expect(coll.status === 409, 'intra-batch duplicate lotCode → 409');

  // ── 4. FEFO ordering: lots with earlier expiry come first ──
  // Re-fetch stock-lots filtered to our stock item; the multi-item lots
  // should have lotB (with expiry) before lotA (no expiry).
  const fefo = await call<{
    data: Array<{ id: string; lotCode: string; expiresAt: string | null }>;
  }>(
    'GET',
    `/stock-lots?stockItemId=${stockItem.id}&limit=100`,
    undefined,
    token,
  );
  expect(fefo.body.success, 'FEFO listing OK');
  const rows = (
    fefo.body as ApiSuccess<{
      data: Array<{ id: string; lotCode: string; expiresAt: string | null }>;
    }>
  ).data.data;
  const idxA = rows.findIndex((r) => r.lotCode === lotA);
  const idxB = rows.findIndex((r) => r.lotCode === lotB);
  expect(idxA >= 0 && idxB >= 0, 'both lots found in FEFO listing');
  expect(
    idxB < idxA,
    `FEFO: lot WITH expiry (${lotB}) ranks before lot WITHOUT expiry (${lotA})`,
  );

  // ── 5. ?sort=newest flips ordering ──
  const newest = await call<{
    data: Array<{ lotCode: string; receivedAt: string }>;
  }>(
    'GET',
    `/stock-lots?stockItemId=${stockItem.id}&sort=newest&limit=20`,
    undefined,
    token,
  );
  const newestRows = (
    newest.body as ApiSuccess<{
      data: Array<{ lotCode: string; receivedAt: string }>;
    }>
  ).data.data;
  if (newestRows.length >= 2) {
    const r0 = new Date(newestRows[0].receivedAt).getTime();
    const r1 = new Date(newestRows[1].receivedAt).getTime();
    expect(r0 >= r1, '?sort=newest orders by receivedAt desc');
  }

  // ── 6. Stock item isActive guard on /stock-lots/receive ──
  const inactive = await prisma.stockItem.create({
    data: {
      sku: `INACTIVE-${stamp}`,
      name: 'Smoke inactive item',
      isActive: false,
      consumptionStrategy: ConsumptionStrategy.WHOLE_ONLY,
      type: 'CLINICAL',
      isSellable: false,
      primaryUnitId: stockItem.primaryUnitId,
    },
  });
  const inactiveReceive = await call(
    'POST',
    '/stock-lots/receive',
    {
      stockItemId: inactive.id,
      warehouseId: warehouse.id,
      lotCode: `INACTIVE-LOT-${stamp}`,
      quantityReceived: 1,
      unitCost: 1,
    },
    token,
  );
  expect(
    inactiveReceive.status === 400,
    'receive against inactive stock item → 400',
  );

  // ── 7. PARTIAL_REQUIRED guard on /service-events/:id/consume-stock ──
  // Find or create a partial-required item + lot, then attempt direct consume.
  let pr1 = await prisma.stockItem.findFirst({
    where: {
      consumptionStrategy: ConsumptionStrategy.PARTIAL_REQUIRED,
      isActive: true,
      deletedAt: null,
    },
  });
  if (!pr1) {
    const baseItem = await prisma.stockItem.findFirst({
      where: {
        consumptionStrategy: ConsumptionStrategy.PARTIAL_ALLOWED,
        isActive: true,
        deletedAt: null,
      },
    });
    if (baseItem) {
      pr1 = await prisma.stockItem.update({
        where: { id: baseItem.id },
        data: { consumptionStrategy: ConsumptionStrategy.PARTIAL_REQUIRED },
      });
    }
  }
  if (!pr1) {
    console.log('  skip PARTIAL_REQUIRED guard (no candidate item)');
  } else {
    const prLot = await prisma.stockLot.create({
      data: {
        stockItemId: pr1.id,
        warehouseId: warehouse.id,
        lotCode: `PR-LOT-${stamp}`,
        quantityReceived: 5,
        quantityOnHand: 5,
        unitCost: 1,
      },
    });
    const event = await prisma.customerServiceEvent.findFirst({
      where: { status: 'IN_PROGRESS' },
    });
    if (!event) {
      console.log(
        '  skip PARTIAL_REQUIRED guard (no IN_PROGRESS service event seeded)',
      );
    } else {
      const direct = await call(
        'POST',
        `/service-events/${event.id}/consume-stock`,
        { stockLotId: prLot.id, quantity: 1 },
        token,
      );
      expect(
        direct.status === 400,
        'PARTIAL_REQUIRED + no openedContainerId → 400',
      );
      expect(
        direct.body.success === false &&
          /OpenedContainer/.test((direct.body as ApiError).error.message),
        'error message points to OpenedContainer flow',
      );
    }
  }

  await prisma.$disconnect();
  console.log('\nALL FIXES SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
