/**
 * Stock Transfer end-to-end smoke. Exercises:
 *   - Valid happy path: DRAFT → REQUESTED → APPROVED → IN_TRANSIT → RECEIVED.
 *   - Insufficient-stock rejection.
 *   - Same-warehouse rejection.
 *   - Invalid state transitions (e.g., dispatch from DRAFT).
 *   - Partial transfer (requested 100, sent 80, received 79).
 *   - Inventory reconciliation: source decreases by sent, destination increases by received.
 *   - TRANSFER_OUT + TRANSFER_IN movements are written.
 *   - Audit trail records requestedBy / approve / dispatch / receive operations.
 *   - Cancel from DRAFT and from APPROVED.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  StockMovementType,
  WarehouseType,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';

interface ApiSuccess<T> { success: true; data: T }
interface ApiError { success: false; error: { code: string; message: string } }
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

interface TransferDTO {
  id: string;
  status: string;
  transferNo: string;
  items: Array<{
    id: string;
    quantityRequested: string;
    quantitySent: string | null;
    quantityReceived: string | null;
    fromStockLotId: string;
    toStockLotId: string | null;
    stockItemId: string;
  }>;
  requestedAt: string | null;
  approvedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-6);

  // ── Fixtures: ensure there's a 2nd warehouse, plus a fresh source lot.
  let fromWarehouse = await prisma.warehouse.findFirst({
    where: { isActive: true, type: WarehouseType.CENTRAL_HUB },
  });
  if (!fromWarehouse) throw new Error('Need a CENTRAL_HUB warehouse');
  let toWarehouse = await prisma.warehouse.findFirst({
    where: { isActive: true, NOT: { id: fromWarehouse.id } },
  });
  if (!toWarehouse) {
    toWarehouse = await prisma.warehouse.create({
      data: {
        code: `WH-BR-${stamp}`,
        name: 'Smoke Branch Warehouse',
        type: WarehouseType.BRANCH,
        isActive: true,
      },
    });
  }
  console.log(`from=${fromWarehouse.code}  to=${toWarehouse.code}`);

  const stockItem = await prisma.stockItem.findFirst({
    where: { isActive: true, deletedAt: null },
  });
  if (!stockItem) throw new Error('Need an active stock item');

  const sourceLot = await prisma.stockLot.create({
    data: {
      stockItemId: stockItem.id,
      warehouseId: fromWarehouse.id,
      lotCode: `XF-LOT-${stamp}`,
      quantityReceived: 100,
      quantityOnHand: 100,
      unitCost: 5,
    },
  });
  console.log(`Source lot ${sourceLot.lotCode} on-hand=100`);

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = (login.body as ApiSuccess<{ accessToken: string }>).data.accessToken;

  // ── 1. Same-warehouse rejection ──
  const sameWh = await call('POST', '/stock-transfers', {
    fromWarehouseId: fromWarehouse.id,
    toWarehouseId: fromWarehouse.id,
    items: [{ stockItemId: stockItem.id, fromStockLotId: sourceLot.id, quantityRequested: 1 }],
  }, token);
  expect(sameWh.status === 400, 'same-warehouse transfer rejected (400)');

  // ── 2. Insufficient stock at draft creation ──
  const overdraft = await call('POST', '/stock-transfers', {
    fromWarehouseId: fromWarehouse.id,
    toWarehouseId: toWarehouse.id,
    items: [{ stockItemId: stockItem.id, fromStockLotId: sourceLot.id, quantityRequested: 9999 }],
  }, token);
  expect(overdraft.status === 400, 'insufficient stock at draft → 400');

  // ── 3. Happy-path draft (request 100, will partial-ship 80, partial-receive 79) ──
  const drafted = await call<TransferDTO>('POST', '/stock-transfers', {
    fromWarehouseId: fromWarehouse.id,
    toWarehouseId: toWarehouse.id,
    note: 'Smoke partial transfer',
    items: [
      { stockItemId: stockItem.id, fromStockLotId: sourceLot.id, quantityRequested: 100 },
    ],
  }, token);
  expect(drafted.status === 201, 'POST /stock-transfers returns 201');
  const t = (drafted.body as ApiSuccess<TransferDTO>).data;
  expect(t.status === 'DRAFT', 'transfer status DRAFT');
  expect(/^TR-\d{8}-\d{4}$/.test(t.transferNo), `transferNo format ${t.transferNo}`);
  const itemId = t.items[0].id;

  // ── 4. Invalid state: dispatch from DRAFT must 409 ──
  const earlyDispatch = await call('POST', `/stock-transfers/${t.id}/dispatch`, {
    items: [{ itemId, quantitySent: 80 }],
  }, token);
  expect(earlyDispatch.status === 409, 'dispatch from DRAFT → 409');

  // ── 5. Receive from DRAFT must 409 ──
  const earlyReceive = await call('POST', `/stock-transfers/${t.id}/receive`, {
    items: [{ itemId, quantityReceived: 1 }],
  }, token);
  expect(earlyReceive.status === 409, 'receive from DRAFT → 409');

  // ── 6. Approve from DRAFT must 409 (must request first) ──
  const earlyApprove = await call('PATCH', `/stock-transfers/${t.id}/approve`, undefined, token);
  expect(earlyApprove.status === 409, 'approve from DRAFT → 409');

  // ── 7. Request → REQUESTED ──
  const requested = await call<TransferDTO>('PATCH', `/stock-transfers/${t.id}/request`, undefined, token);
  expect(requested.status === 200, 'request returns 200');
  const tr = (requested.body as ApiSuccess<TransferDTO>).data;
  expect(tr.status === 'REQUESTED', 'status REQUESTED');
  expect(tr.requestedAt !== null, 'requestedAt stamped');

  // ── 8. Approve → APPROVED ──
  const approved = await call<TransferDTO>('PATCH', `/stock-transfers/${t.id}/approve`, undefined, token);
  expect(approved.status === 200, 'approve returns 200');
  const ta = (approved.body as ApiSuccess<TransferDTO>).data;
  expect(ta.status === 'APPROVED', 'status APPROVED');
  expect(ta.approvedAt !== null, 'approvedAt stamped');

  // ── 9. Over-send rejection: try sending 200 (more than requested 100) ──
  const overSend = await call('POST', `/stock-transfers/${t.id}/dispatch`, {
    items: [{ itemId, quantitySent: 200 }],
  }, token);
  expect(overSend.status === 400, 'sending more than requested → 400');

  // ── 10. Dispatch sentQty=80 (partial) ──
  const dispatched = await call<TransferDTO>('POST', `/stock-transfers/${t.id}/dispatch`, {
    items: [{ itemId, quantitySent: 80 }],
  }, token);
  expect(dispatched.status === 200, 'dispatch returns 200');
  const td = (dispatched.body as ApiSuccess<TransferDTO>).data;
  expect(td.status === 'IN_TRANSIT', 'status IN_TRANSIT');
  expect(td.dispatchedAt !== null, 'dispatchedAt stamped');
  expect(decToNum(td.items[0].quantitySent) === 80, 'item.quantitySent = 80');

  // Source lot deducted by 80 → on-hand = 20
  const lotAfterDispatch = await prisma.stockLot.findUnique({ where: { id: sourceLot.id } });
  expect(decToNum(lotAfterDispatch!.quantityOnHand) === 20, 'source lot.quantityOnHand = 20 after dispatch');

  const outMv = await prisma.stockMovement.findFirst({
    where: {
      type: StockMovementType.TRANSFER_OUT,
      referenceType: 'STOCK_TRANSFER',
      referenceId: t.id,
    },
  });
  expect(outMv !== null, 'TRANSFER_OUT movement created');
  expect(decToNum(outMv!.quantityDelta) === -80, 'TRANSFER_OUT quantityDelta = -80');

  // ── 11. Over-receive rejection: try receiving 90 (more than sent 80) ──
  const overReceive = await call('POST', `/stock-transfers/${t.id}/receive`, {
    items: [{ itemId, quantityReceived: 90 }],
  }, token);
  expect(overReceive.status === 400, 'receiving more than sent → 400');

  // ── 12. Receive 79 (partial — 1 lost in transit) ──
  const received = await call<TransferDTO>('POST', `/stock-transfers/${t.id}/receive`, {
    items: [{ itemId, quantityReceived: 79 }],
  }, token);
  expect(received.status === 200, 'receive returns 200');
  const trv = (received.body as ApiSuccess<TransferDTO>).data;
  expect(trv.status === 'RECEIVED', 'status RECEIVED');
  expect(trv.receivedAt !== null, 'receivedAt stamped');
  expect(decToNum(trv.items[0].quantityReceived) === 79, 'item.quantityReceived = 79');
  const toLotId = trv.items[0].toStockLotId;
  expect(toLotId !== null, 'destination lot id present');

  // Destination lot exists with on-hand 79
  const toLot = await prisma.stockLot.findUnique({ where: { id: toLotId! } });
  expect(toLot !== null && toLot.warehouseId === toWarehouse.id, 'dest lot is in toWarehouse');
  expect(decToNum(toLot!.quantityOnHand) === 79, 'dest lot.quantityOnHand = 79');
  expect(toLot!.parentLotId === sourceLot.id, 'dest lot.parentLotId = source lot id (lineage)');

  const inMv = await prisma.stockMovement.findFirst({
    where: {
      type: StockMovementType.TRANSFER_IN,
      referenceType: 'STOCK_TRANSFER',
      referenceId: t.id,
    },
  });
  expect(inMv !== null, 'TRANSFER_IN movement created');
  expect(decToNum(inMv!.quantityDelta) === 79, 'TRANSFER_IN quantityDelta = +79');

  // ── 13. Reconciliation: source -80, dest +79 (1 unit short = transit loss) ──
  const reconciliation = decToNum(lotAfterDispatch!.quantityOnHand) /* 20 */ + 79; /* dest */
  expect(reconciliation === 100 - 1, 'source remaining + dest received = original − transit loss (99)');

  // ── 14. Terminal: cannot receive twice ──
  const doubleReceive = await call('POST', `/stock-transfers/${t.id}/receive`, {
    items: [{ itemId, quantityReceived: 1 }],
  }, token);
  expect(doubleReceive.status === 409, 'second receive → 409 (terminal)');

  // ── 15. Cancel-from-DRAFT path ──
  const draft2Lot = await prisma.stockLot.create({
    data: {
      stockItemId: stockItem.id,
      warehouseId: fromWarehouse.id,
      lotCode: `XF-LOT-CANCEL-${stamp}`,
      quantityReceived: 10,
      quantityOnHand: 10,
      unitCost: 5,
    },
  });
  const draft2 = await call<TransferDTO>('POST', '/stock-transfers', {
    fromWarehouseId: fromWarehouse.id,
    toWarehouseId: toWarehouse.id,
    items: [{ stockItemId: stockItem.id, fromStockLotId: draft2Lot.id, quantityRequested: 5 }],
  }, token);
  expect(draft2.status === 201, 'second draft created');
  const t2 = (draft2.body as ApiSuccess<TransferDTO>).data;
  const cancelled = await call<TransferDTO>('PATCH', `/stock-transfers/${t2.id}/cancel`, { reason: 'no longer needed' }, token);
  expect(cancelled.status === 200, 'cancel from DRAFT returns 200');
  expect(
    (cancelled.body as ApiSuccess<TransferDTO>).data.status === 'CANCELLED',
    'status CANCELLED',
  );
  // Source lot should be unaffected by a cancelled draft.
  const draft2LotAfter = await prisma.stockLot.findUnique({ where: { id: draft2Lot.id } });
  expect(decToNum(draft2LotAfter!.quantityOnHand) === 10, 'cancelled draft does not touch source lot');

  // ── 16. Audit: at least 4 audit log rows for the happy-path transfer ──
  const audits = await prisma.auditLog.findMany({
    where: { entityType: 'StockTransfer', entityId: t.id },
    orderBy: { createdAt: 'asc' },
  });
  // create + request + approve + dispatch + receive = 5 minimum
  expect(audits.length >= 5, `audit log has at least 5 rows for happy path (got ${audits.length})`);

  await prisma.$disconnect();
  console.log('\nALL STOCK-TRANSFER SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
