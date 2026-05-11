/**
 * Smoke for the BranchStockSales module.
 *
 * Covers, end-to-end against a running dev server:
 *   - DRAFT creation with FEFO allocation across two lots (auto-split).
 *   - Sellable / active / branch-warehouse validation rejections.
 *   - DRAFT → PAID → COMPLETED happy path with RETAIL_SALE movements
 *     written and `quantityOnHand` debited.
 *   - PAID → CANCELLED (no inventory impact).
 *   - Refund request + approval restoring stock to the original lots,
 *     creating RETURN movements, and flipping sale to PARTIALLY_REFUNDED /
 *     REFUNDED.
 *   - Invalid state transitions rejected.
 *   - Pagination + filter on /branch-stock-sales.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  BranchStockSaleStatus,
  PrismaClient,
  RefundStatus,
  StockLotStatus,
  StockMovementType,
  WarehouseType,
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
const round2cents = (n: number): number => Math.round(n * 100) / 100;

interface SaleItemResp {
  id: string;
  stockItemId: string;
  stockLotId: string;
  quantity: string;
  unitPrice: string;
  netAmount: string;
}
interface SaleResp {
  id: string;
  saleNo: string;
  status: BranchStockSaleStatus;
  branchId: string;
  totalAmount: string;
  subtotalAmount: string;
  discountAmount: string;
  refundAmount: string;
  paidAt: string | null;
  items: SaleItemResp[];
  refunds: Array<{ id: string; refundNo: string; status: RefundStatus }>;
}
interface RefundResp {
  id: string;
  refundNo: string;
  status: RefundStatus;
  amount: string;
  branchStockSaleId: string;
}
interface ListResp<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-6);

  // ── Bootstrap: branch + warehouse + sellable stock item + 2 lots (FEFO) ──
  const branch = await prisma.branch.findFirst({ where: { status: 'ACTIVE' } });
  if (!branch) throw new Error('Need an active branch (run seed first)');
  let warehouse = await prisma.warehouse.findFirst({
    where: { branchId: branch.id, type: WarehouseType.BRANCH, isActive: true },
  });
  if (!warehouse) {
    warehouse = await prisma.warehouse.create({
      data: {
        code: `BSS-WH-${stamp}`,
        name: `BSS Smoke WH ${stamp}`,
        type: WarehouseType.BRANCH,
        branchId: branch.id,
      },
    });
  }
  const salesChannel = await prisma.salesChannel.findFirst({
    where: { isActive: true },
  });
  if (!salesChannel) throw new Error('Need an active sales channel');

  const unit = await prisma.unit.findFirst({ where: { isActive: true } });
  if (!unit) throw new Error('Need an active unit');

  const sellableItem = await prisma.stockItem.create({
    data: {
      sku: `BSS-SELL-${stamp}`,
      name: `BSS Sellable ${stamp}`,
      type: 'RETAIL',
      isSellable: true,
      isActive: true,
      consumptionStrategy: 'WHOLE_ONLY',
      primaryUnitId: unit.id,
    },
  });
  const nonSellableItem = await prisma.stockItem.create({
    data: {
      sku: `BSS-NOSELL-${stamp}`,
      name: `BSS NonSellable ${stamp}`,
      type: 'CLINICAL',
      isSellable: false,
      isActive: true,
      consumptionStrategy: 'WHOLE_ONLY',
      primaryUnitId: unit.id,
    },
  });

  // Two lots: lotA expires sooner (FEFO winner) but only has 30 units —
  // requesting 50 units must split into 30 from lotA + 20 from lotB.
  const lotA = await prisma.stockLot.create({
    data: {
      stockItemId: sellableItem.id,
      warehouseId: warehouse.id,
      lotCode: `BSS-A-${stamp}`,
      quantityReceived: 30,
      quantityOnHand: 30,
      unitCost: 10,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  const lotB = await prisma.stockLot.create({
    data: {
      stockItemId: sellableItem.id,
      warehouseId: warehouse.id,
      lotCode: `BSS-B-${stamp}`,
      quantityReceived: 100,
      quantityOnHand: 100,
      unitCost: 12,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ── 1. Reject non-sellable item ──
  const reject1 = await call<SaleResp>(
    'POST',
    '/branch-stock-sales',
    {
      branchId: branch.id,
      salesChannelId: salesChannel.id,
      items: [{ stockItemId: nonSellableItem.id, quantity: 1, unitPrice: 5 }],
    },
    token,
  );
  expect(reject1.status === 400, 'non-sellable item rejected with 400');
  expect(
    !reject1.body.success &&
      /not sellable/i.test((reject1.body as ApiError).error.message),
    'rejection message mentions sellable',
  );

  // ── 2. Reject branches without a BRANCH warehouse ──
  // Easiest path: create a fresh isolated branch with no warehouse.
  const orphanBranch = await prisma.branch.create({
    data: { code: `ORPH-${stamp}`, name: `Orphan ${stamp}`, status: 'ACTIVE' },
  });
  const reject2 = await call<SaleResp>(
    'POST',
    '/branch-stock-sales',
    {
      branchId: orphanBranch.id,
      salesChannelId: salesChannel.id,
      items: [{ stockItemId: sellableItem.id, quantity: 1, unitPrice: 5 }],
    },
    token,
  );
  expect(
    reject2.status === 400 &&
      !reject2.body.success &&
      /BRANCH-type warehouse/i.test((reject2.body as ApiError).error.message),
    'branch with no BRANCH warehouse → 400 with helpful message',
  );

  // ── 3. Create DRAFT with FEFO split across lots ──
  const create = await call<SaleResp>(
    'POST',
    '/branch-stock-sales',
    {
      branchId: branch.id,
      salesChannelId: salesChannel.id,
      discountAmount: 50,
      items: [{ stockItemId: sellableItem.id, quantity: 50, unitPrice: 20 }],
    },
    token,
  );
  expect(create.status === 201, 'create DRAFT returns 201');
  const sale = unwrap(create);
  expect(sale.status === 'DRAFT', 'sale status = DRAFT');
  expect(
    /^BSS-\d{8}-\d{4}$/.test(sale.saleNo),
    'saleNo format BSS-YYYYMMDD-####',
  );
  expect(sale.items.length === 2, 'FEFO split into 2 sale items');
  // Order check: lotA first (earlier expiry), lotB second.
  const itemForLotA = sale.items.find((i) => i.stockLotId === lotA.id);
  const itemForLotB = sale.items.find((i) => i.stockLotId === lotB.id);
  expect(!!itemForLotA && !!itemForLotB, 'both lot ids present in sale items');
  expect(
    decToNum(itemForLotA!.quantity) === 30,
    'lotA contributed 30 (FEFO first)',
  );
  expect(
    decToNum(itemForLotB!.quantity) === 20,
    'lotB contributed remaining 20',
  );
  expect(decToNum(sale.subtotalAmount) === 1000, 'subtotal = 50 * 20 = 1000');
  // Spec §1: subtotal = sum(item.netAmount); total = subtotal - discount.
  const sumOfNet = sale.items.reduce(
    (acc, it) => round2cents(acc + decToNum(it.netAmount)),
    0,
  );
  expect(
    sumOfNet === decToNum(sale.subtotalAmount),
    'subtotalAmount === Σ items.netAmount (gross line totals)',
  );
  expect(
    decToNum(sale.totalAmount) ===
      round2cents(
        decToNum(sale.subtotalAmount) - decToNum(sale.discountAmount),
      ),
    'totalAmount === subtotalAmount - discountAmount',
  );
  expect(
    decToNum(sale.totalAmount) === 950,
    'total = 1000 - 50 discount = 950',
  );
  // Stock on hand must be UNTOUCHED at draft time.
  const lotAAfterDraft = await prisma.stockLot.findUnique({
    where: { id: lotA.id },
  });
  expect(
    decToNum(lotAAfterDraft!.quantityOnHand) === 30,
    'draft does NOT debit lot A',
  );

  // ── 4. Reject insufficient stock ──
  const insuff = await call(
    'POST',
    '/branch-stock-sales',
    {
      branchId: branch.id,
      salesChannelId: salesChannel.id,
      items: [
        { stockItemId: sellableItem.id, quantity: 999_999, unitPrice: 1 },
      ],
    },
    token,
  );
  expect(insuff.status === 400, 'insufficient stock → 400');

  // ── 5. Cannot complete from DRAFT (must pay first) ──
  const earlyComplete = await call<SaleResp>(
    'PATCH',
    `/branch-stock-sales/${sale.id}/complete`,
    {},
    token,
  );
  expect(earlyComplete.status === 409, 'DRAFT → COMPLETED rejected (409)');

  // ── 6a. Underpayment is rejected (paidAmount < totalAmount) ──
  const under = await call<SaleResp>(
    'PATCH',
    `/branch-stock-sales/${sale.id}/pay`,
    { paidAmount: 100 },
    token,
  );
  expect(under.status === 400, 'underpayment → 400');
  expect(
    !under.body.success &&
      /less than totalAmount/i.test((under.body as ApiError).error.message),
    'underpayment error mentions totalAmount',
  );

  // ── 6b. Missing paidAmount also rejected (DTO validation) ──
  const noAmount = await call<SaleResp>(
    'PATCH',
    `/branch-stock-sales/${sale.id}/pay`,
    {},
    token,
  );
  expect(noAmount.status === 400, 'missing paidAmount → 400 (DTO validation)');

  // ── 6c. Pay with sufficient paidAmount ──
  const paid = unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${sale.id}/pay`,
      { paidAmount: 950, paymentReference: `RCPT-${stamp}` },
      token,
    ),
  );
  expect(paid.status === 'PAID', 'sale flipped to PAID');
  expect(paid.paidAt !== null, 'paidAt stamped');

  // ── 7. Complete: deduct stock + RETAIL_SALE movements ──
  const completed = unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${sale.id}/complete`,
      {},
      token,
    ),
  );
  expect(completed.status === 'COMPLETED', 'sale flipped to COMPLETED');

  const lotAAfter = await prisma.stockLot.findUnique({
    where: { id: lotA.id },
  });
  const lotBAfter = await prisma.stockLot.findUnique({
    where: { id: lotB.id },
  });
  expect(
    decToNum(lotAAfter!.quantityOnHand) === 0,
    'lotA fully drained → quantityOnHand = 0',
  );
  expect(
    lotAAfter!.status === StockLotStatus.EXHAUSTED,
    'lotA flipped to EXHAUSTED',
  );
  expect(
    decToNum(lotBAfter!.quantityOnHand) === 80,
    'lotB debited by 20 → 80 remaining',
  );
  expect(lotBAfter!.status === StockLotStatus.ACTIVE, 'lotB still ACTIVE');

  const movements = await prisma.stockMovement.findMany({
    where: {
      type: StockMovementType.RETAIL_SALE,
      referenceType: 'BRANCH_STOCK_SALE',
      referenceId: sale.id,
    },
  });
  expect(movements.length === 2, '2 RETAIL_SALE movements written');
  const totalDelta = movements.reduce(
    (acc, m) => acc + decToNum(m.quantityDelta),
    0,
  );
  expect(totalDelta === -50, 'sum of deltas = -50');

  // ── 8. Cannot cancel a COMPLETED sale ──
  const cancelDenied = await call(
    'PATCH',
    `/branch-stock-sales/${sale.id}/cancel`,
    { reason: 'oops' },
    token,
  );
  expect(
    cancelDenied.status === 409,
    'cancel after complete → 409 (must use refund)',
  );

  // ── 9. Refund: request + approve, partial first ──
  const refundReq = unwrap(
    await call<RefundResp>(
      'POST',
      `/branch-stock-sales/${sale.id}/refund`,
      {
        items: [{ saleItemId: itemForLotA!.id, quantity: 10 }],
        reason: 'returned 10 from lotA',
      },
      token,
    ),
  );
  expect(refundReq.status === 'REQUESTED', 'refund opened in REQUESTED');
  expect(/^BSR-\d{8}-\d{4}$/.test(refundReq.refundNo), 'refundNo format');
  // Per-unit net = (1000 - 50) / 50 = 19 (sale-level discount distributed).
  expect(
    decToNum(refundReq.amount) === 190,
    'amount = 10 * 19 (post-discount per-unit) = 190',
  );
  // Stock should NOT yet be restored.
  const lotAStillExhausted = await prisma.stockLot.findUnique({
    where: { id: lotA.id },
  });
  expect(
    decToNum(lotAStillExhausted!.quantityOnHand) === 0,
    'refund-request does NOT restore stock',
  );

  // Approve.
  const approved = unwrap(
    await call<RefundResp>(
      'PATCH',
      `/branch-stock-sales/refunds/${refundReq.id}/approve`,
      {},
      token,
    ),
  );
  expect(approved.status === 'COMPLETED', 'refund flipped to COMPLETED');

  const lotAAfterRefund = await prisma.stockLot.findUnique({
    where: { id: lotA.id },
  });
  expect(
    decToNum(lotAAfterRefund!.quantityOnHand) === 10,
    'lotA stock restored by 10',
  );
  expect(
    lotAAfterRefund!.status === StockLotStatus.ACTIVE,
    'EXHAUSTED lotA reactivated to ACTIVE on refund',
  );

  const returnMovements = await prisma.stockMovement.findMany({
    where: {
      type: StockMovementType.RETURN,
      referenceType: 'BRANCH_STOCK_SALE_REFUND',
      referenceId: refundReq.id,
    },
  });
  expect(returnMovements.length === 1, '1 RETURN movement written');
  expect(
    decToNum(returnMovements[0].quantityDelta) === 10,
    'RETURN delta = +10',
  );

  // Sale should now be PARTIALLY_REFUNDED with refundAmount = 200.
  const saleAfterPartial = unwrap(
    await call<SaleResp>(
      'GET',
      `/branch-stock-sales/${sale.id}`,
      undefined,
      token,
    ),
  );
  expect(
    saleAfterPartial.status === 'PARTIALLY_REFUNDED',
    'sale → PARTIALLY_REFUNDED after partial refund',
  );
  expect(
    decToNum(saleAfterPartial.refundAmount) === 190,
    'refundAmount = 190 (post-discount per-unit × refunded qty)',
  );

  // ── 10. Refund the remainder, sale flips to REFUNDED ──
  const remainingFromA = unwrap(
    await call<RefundResp>(
      'POST',
      `/branch-stock-sales/${sale.id}/refund`,
      {
        items: [
          { saleItemId: itemForLotA!.id, quantity: 20 },
          { saleItemId: itemForLotB!.id, quantity: 20 },
        ],
      },
      token,
    ),
  );
  // Remaining: 20 of lotA (final on lotA → settles to its net residual 380)
  // + 20 of lotB (final on lotB → 380). Total = 760.
  expect(
    decToNum(remainingFromA.amount) === 760,
    'remainder amount settles to net residual: 380 + 380 = 760',
  );

  unwrap(
    await call<RefundResp>(
      'PATCH',
      `/branch-stock-sales/refunds/${remainingFromA.id}/approve`,
      {},
      token,
    ),
  );

  const saleFinal = unwrap(
    await call<SaleResp>(
      'GET',
      `/branch-stock-sales/${sale.id}`,
      undefined,
      token,
    ),
  );
  expect(saleFinal.status === 'REFUNDED', 'sale → REFUNDED after full refund');
  expect(
    decToNum(saleFinal.refundAmount) === decToNum(saleFinal.totalAmount),
    'cumulative refundAmount = totalAmount',
  );

  // ── 11. Cannot refund a fully-refunded sale ──
  // A REFUNDED sale is closed; a follow-up refund returns 409.
  const overRefund = await call(
    'POST',
    `/branch-stock-sales/${sale.id}/refund`,
    {
      items: [{ saleItemId: itemForLotA!.id, quantity: 1 }],
    },
    token,
  );
  expect(overRefund.status === 409, 'refunding a REFUNDED sale → 409');

  // ── 11b. Cannot refund more than originally sold (mid-cycle) ──
  // Build a fresh sale, complete it, then over-refund a single line.
  const overSale = unwrap(
    await call<SaleResp>(
      'POST',
      '/branch-stock-sales',
      {
        branchId: branch.id,
        salesChannelId: salesChannel.id,
        items: [{ stockItemId: sellableItem.id, quantity: 3, unitPrice: 10 }],
      },
      token,
    ),
  );
  unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${overSale.id}/pay`,
      { paidAmount: 30 },
      token,
    ),
  );
  unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${overSale.id}/complete`,
      {},
      token,
    ),
  );
  const overSaleItem = overSale.items[0];
  const overQty = await call(
    'POST',
    `/branch-stock-sales/${overSale.id}/refund`,
    { items: [{ saleItemId: overSaleItem.id, quantity: 999 }] },
    token,
  );
  expect(
    overQty.status === 400,
    'refunding past original quantity (mid-cycle) → 400',
  );

  // ── 12a. Cancel a DRAFT sale (the only legal path per spec §5) ──
  const cancellable = unwrap(
    await call<SaleResp>(
      'POST',
      '/branch-stock-sales',
      {
        branchId: branch.id,
        salesChannelId: salesChannel.id,
        items: [{ stockItemId: sellableItem.id, quantity: 5, unitPrice: 7 }],
      },
      token,
    ),
  );
  const cancelled = unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${cancellable.id}/cancel`,
      { reason: 'customer changed mind' },
      token,
    ),
  );
  expect(cancelled.status === 'CANCELLED', 'DRAFT → CANCELLED works');
  const cancelMovements = await prisma.stockMovement.findMany({
    where: {
      referenceType: 'BRANCH_STOCK_SALE',
      referenceId: cancellable.id,
    },
  });
  expect(
    cancelMovements.length === 0,
    'cancel writes zero stock movements (inventory untouched)',
  );

  // ── 12b. Cancel from PAID is rejected per spec §5 ──
  const paidNoCancel = unwrap(
    await call<SaleResp>(
      'POST',
      '/branch-stock-sales',
      {
        branchId: branch.id,
        salesChannelId: salesChannel.id,
        items: [{ stockItemId: sellableItem.id, quantity: 2, unitPrice: 5 }],
      },
      token,
    ),
  );
  unwrap(
    await call<SaleResp>(
      'PATCH',
      `/branch-stock-sales/${paidNoCancel.id}/pay`,
      { paidAmount: 10 },
      token,
    ),
  );
  const cancelPaid = await call(
    'PATCH',
    `/branch-stock-sales/${paidNoCancel.id}/cancel`,
    {},
    token,
  );
  expect(cancelPaid.status === 409, 'cancel from PAID → 409 (spec §5)');

  // ── 13. Pagination + filter ──
  const list = unwrap(
    await call<ListResp<SaleResp>>(
      'GET',
      `/branch-stock-sales?branchId=${branch.id}&limit=2&page=1`,
      undefined,
      token,
    ),
  );
  expect(list.meta.limit === 2, 'pagination limit honored');
  expect(list.data.length <= 2, 'page contains <= 2 rows');
  expect(list.meta.total >= 2, 'meta.total reflects all matching sales');

  await prisma.$disconnect();
  console.log('\nALL BRANCH-STOCK-SALES SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
