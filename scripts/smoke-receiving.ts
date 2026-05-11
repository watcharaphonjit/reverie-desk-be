/**
 * End-to-end smoke for the inventory receiving stack.
 *  1. Login as admin
 *  2. POST /suppliers
 *  3. PATCH /suppliers/:id
 *  4. POST /suppliers (duplicate code -> 409)
 *  5. POST /purchase-receipts
 *  6. GET /purchase-receipts
 *  7. POST /stock-lots/receive (happy path) → records lot + PURCHASE_IN movement
 *  8. POST /stock-lots/receive (lotCode collision) → 409
 *  9. GET /stock-lots?warehouseId=...&supplierId=...
 * 10. GET /stock-lots/expiring?days=60
 * 11. Direct-DB assertions against the resulting StockLot + StockMovement
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, StockMovementType } from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';

interface ApiSuccess<T> {
  success: true;
  data: T;
}
interface ApiError {
  success: false;
  error: { code: string; message: string; details?: unknown };
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
  if (!cond) {
    throw new Error(`ASSERT FAIL: ${msg}`);
  }
  console.log(`  ok   ${msg}`);
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });

  // ── Step 0: locate an existing warehouse + active stock item ──
  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
  });
  if (!warehouse) throw new Error('No active warehouse seeded');
  const stockItem = await prisma.stockItem.findFirst({
    where: { isActive: true, deletedAt: null },
  });
  if (!stockItem) throw new Error('No active stock item seeded');
  console.log(
    `Using warehouse=${warehouse.code} (${warehouse.id}), stockItem=${stockItem.sku} (${stockItem.id})`,
  );

  // ── Step 1: login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(
    login.body.success && !!(login.body as ApiSuccess<{ accessToken: string }>).data.accessToken,
    'admin login returns access token',
  );
  const token = (login.body as ApiSuccess<{ accessToken: string }>).data.accessToken;

  const stamp = Date.now().toString().slice(-6);

  // ── Step 2: create supplier ──
  const supplierCode = `SUP-${stamp}`;
  const create = await call<{ id: string; code: string; name: string }>(
    'POST',
    '/suppliers',
    { code: supplierCode.toLowerCase(), name: 'Demo Supplier Co.', phone: '+66800000001' },
    token,
  );
  expect(create.status === 201 && create.body.success, 'POST /suppliers returns 201');
  const supplier = (create.body as ApiSuccess<{ id: string; code: string; name: string }>).data;
  expect(supplier.code === supplierCode, 'supplier code is auto-uppercased');

  // ── Step 3: patch supplier ──
  const patched = await call<{ name: string }>(
    'PATCH',
    `/suppliers/${supplier.id}`,
    { name: 'Demo Supplier Co. (Renamed)' },
    token,
  );
  expect(
    patched.body.success &&
      (patched.body as ApiSuccess<{ name: string }>).data.name === 'Demo Supplier Co. (Renamed)',
    'PATCH /suppliers/:id updates name',
  );

  // ── Step 4: duplicate code conflict ──
  const dup = await call('POST', '/suppliers', {
    code: supplierCode,
    name: 'Other',
  }, token);
  expect(dup.status === 409, 'duplicate supplier code → 409');

  // ── Step 5: create purchase receipt ──
  const receipt = await call<{ id: string; referenceNo: string }>(
    'POST',
    '/purchase-receipts',
    { supplierId: supplier.id, branchId: warehouse.branchId ?? undefined },
    token,
  );
  expect(receipt.status === 201, 'POST /purchase-receipts returns 201');
  const pr = (receipt.body as ApiSuccess<{ id: string; referenceNo: string }>).data;
  expect(/^PR-\d{8}-\d{4}$/.test(pr.referenceNo), `referenceNo matches PR-YYYYMMDD-XXXX (${pr.referenceNo})`);

  // ── Step 6: list receipts ──
  const list = await call<{ data: Array<{ id: string }>; meta: { total: number } }>(
    'GET',
    '/purchase-receipts?limit=5',
    undefined,
    token,
  );
  expect(
    list.body.success &&
      (list.body as ApiSuccess<{ data: Array<{ id: string }>; meta: { total: number } }>).data.data
        .some((r) => r.id === pr.id),
    'GET /purchase-receipts contains the new receipt',
  );

  // ── Step 7: receive stock (happy path) ──
  const lotCode = `LOT-${stamp}`;
  const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000); // 45 days out
  const receive = await call<{
    id: string;
    lotCode: string;
    quantityOnHand: string;
    quantityReceived: string;
  }>(
    'POST',
    '/stock-lots/receive',
    {
      stockItemId: stockItem.id,
      warehouseId: warehouse.id,
      lotCode,
      quantityReceived: 25,
      unitCost: 8.5,
      supplierId: supplier.id,
      purchaseReceiptId: pr.id,
      purchaseReference: 'INV-001',
      expiresAt: expiresAt.toISOString(),
      note: 'Smoke test receipt',
    },
    token,
  );
  expect(receive.status === 201, 'POST /stock-lots/receive returns 201');
  const lot = (
    receive.body as ApiSuccess<{
      id: string;
      lotCode: string;
      quantityOnHand: string;
      quantityReceived: string;
    }>
  ).data;
  expect(lot.lotCode === lotCode, 'lotCode echoed back');
  expect(Number(lot.quantityOnHand) === 25, 'quantityOnHand = 25');
  expect(Number(lot.quantityReceived) === 25, 'quantityReceived = 25');

  // ── Step 8: lotCode collision in same warehouse ──
  const collision = await call('POST', '/stock-lots/receive', {
    stockItemId: stockItem.id,
    warehouseId: warehouse.id,
    lotCode,
    quantityReceived: 1,
    unitCost: 1,
  }, token);
  expect(collision.status === 409, 'duplicate lotCode in same warehouse → 409');

  // ── Step 9: list lots filtered by warehouse + supplier ──
  const filtered = await call<{ data: Array<{ id: string }> }>(
    'GET',
    `/stock-lots?warehouseId=${warehouse.id}&supplierId=${supplier.id}`,
    undefined,
    token,
  );
  expect(
    filtered.body.success &&
      (filtered.body as ApiSuccess<{ data: Array<{ id: string }> }>).data.data.some(
        (l) => l.id === lot.id,
      ),
    'GET /stock-lots filtered by warehouseId+supplierId returns the new lot',
  );

  // ── Step 10: expiring within 60 days (45-day expiry should appear) ──
  const expiring = await call<{ data: Array<{ id: string }>; meta: { total: number } }>(
    'GET',
    '/stock-lots/expiring?days=60',
    undefined,
    token,
  );
  expect(
    expiring.body.success &&
      (expiring.body as ApiSuccess<{ data: Array<{ id: string }>; meta: { total: number } }>).data.data
        .some((l) => l.id === lot.id),
    'GET /stock-lots/expiring?days=60 includes the new lot',
  );

  // ── Step 10b: expiring within 1 day (45-day expiry should NOT appear) ──
  const tight = await call<{ data: Array<{ id: string }> }>(
    'GET',
    '/stock-lots/expiring?days=1',
    undefined,
    token,
  );
  expect(
    tight.body.success &&
      !(tight.body as ApiSuccess<{ data: Array<{ id: string }> }>).data.data
        .some((l) => l.id === lot.id),
    'GET /stock-lots/expiring?days=1 excludes the 45-day lot',
  );

  // ── Step 11: direct-DB checks for movement + receipt link ──
  const movement = await prisma.stockMovement.findFirst({
    where: { stockLotId: lot.id, type: StockMovementType.PURCHASE_IN },
  });
  expect(!!movement, 'PURCHASE_IN StockMovement was created');
  expect(
    movement!.warehouseId === warehouse.id,
    'movement.warehouseId matches the lot warehouse',
  );
  expect(
    Number(movement!.quantityDelta.toString()) === 25,
    'movement.quantityDelta = +25',
  );
  expect(
    movement!.referenceType === 'PURCHASE_RECEIPT' && movement!.referenceId === pr.id,
    'movement references the PurchaseReceipt',
  );

  const lotRow = await prisma.stockLot.findUnique({ where: { id: lot.id } });
  expect(
    lotRow !== null &&
      Number(lotRow.quantityOnHand.toString()) === 25 &&
      Number(lotRow.quantityReceived.toString()) === 25,
    'StockLot row has matching quantities',
  );

  await prisma.$disconnect();
  console.log('\nALL RECEIVING SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
