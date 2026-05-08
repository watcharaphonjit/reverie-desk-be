/**
 * Smoke for Commission Engine + Refund + Wallet Ledger.
 *
 * Walks every Success Criterion in the spec:
 *
 *   Commission Engine:
 *     ✓ Service group resolution works
 *     ✓ Tier lookup selects highest valid threshold
 *     ✓ Fixed commission works
 *     ✓ Percentage commission works
 *     ✓ Mixed-order multi-group works
 *     ✓ Multiple snapshots created correctly
 *     ✓ Idempotency: re-evaluation creates 0 new commissions
 *     ✓ Lifecycle: ELIGIBLE → LOCKED → PAID transitions
 *
 *   Refund:
 *     ✓ Refund request validates against paid sum
 *     ✓ Approval works
 *     ✓ Completion revokes non-PAID commissions
 *     ✓ Completion preserves PAID commissions
 *     ✓ Completion credits wallet (DEPOSIT)
 *
 *   Wallet:
 *     ✓ Wallet auto-created on first credit
 *     ✓ Credit / debit work
 *     ✓ Debit rejects on insufficient balance (no negatives)
 *     ✓ Transfer atomic
 *
 *   Integrations:
 *     ✓ Deposit payment creates wallet txn (ref=PAYMENT)
 *     ✓ Sales order auto-evaluates commissions on deposit satisfied
 *     ✓ Audit logs created for evaluate / lock / pay / refund / wallet
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CommissionStatus,
  CommissionType,
  PrismaClient,
  RefundStatus,
  RefundType,
  SalesOrderStatus,
  ServiceGroupCode,
  WalletReferenceType,
  WalletType,
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
const num = (v: unknown): number => Number(typeof v === 'string' ? v : v);

// ─────────────────────────── shapes ───────────────────────────

interface BulkUpsertResp {
  bundlesUpdated: number;
  tiersWritten: number;
}
interface CommissionResp {
  id: string;
  type: CommissionType;
  status: CommissionStatus;
  amount: string | number;
  recipientUserId: string;
  salesOrderId: string;
  snapshot: {
    id: string;
    serviceGroupCode: ServiceGroupCode | null;
    snapshotBranchName: string | null;
    snapshotSaleCreatorName: string;
    snapshotLeadOwnerName: string | null;
    groupSubtotal: string | null;
  };
}
interface EvaluateResp {
  salesOrderId: string;
  createdCount: number;
  skippedExistingCount: number;
  ineligibleGroups: Array<{ group: string; type: string; reason: string }>;
  commissions: CommissionResp[];
}
interface RefundResp {
  id: string;
  refundNo: string;
  status: RefundStatus;
  amount: string;
  approvedByUserId: string | null;
  approvedAt: string | null;
  completedAt: string | null;
}
interface WalletResp {
  id: string;
  customerId: string;
  type: WalletType;
  balance: string;
  isActive: boolean;
}
interface WalletTxnResp {
  wallet: WalletResp;
  transaction: {
    id: string;
    type: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    referenceType: WalletReferenceType | null;
    referenceId: string | null;
  };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-7);

  // ── Bootstrap ──
  const branch = await prisma.branch.findFirst({ where: { status: 'ACTIVE' } });
  if (!branch) throw new Error('Need an active ACTIVE branch');
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  if (!adminUser) throw new Error('Need admin user');

  // Lead owner is a separate user so we can prove LEAD_REWARD goes to the
  // owner and SALES_COMMISSION goes to the order creator.
  let leadOwner = await prisma.user.findFirst({
    where: { email: { startsWith: 'lead-owner-' } },
  });
  if (!leadOwner) {
    leadOwner = await prisma.user.create({
      data: {
        email: `lead-owner-${stamp}@reverie.local`,
        fullName: `Lead Owner ${stamp}`,
        passwordHash: 'unused',
        branchId: branch.id,
        status: 'ACTIVE',
      },
    });
  }

  const customer = await prisma.customer.create({
    data: {
      code: `CUST-CRW-${stamp}`,
      fullName: `Smoke CRW Customer ${stamp}`,
      phone: `+669${stamp}`,
      currentBranchId: branch.id,
    },
  });

  // Lead with a current owner — required for LEAD_REWARD eligibility.
  const lead = await prisma.lead.create({
    data: {
      code: `LEAD-CRW-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      name: customer.fullName,
      phone: customer.phone,
      currentOwnerUserId: leadOwner.id,
      createdByUserId: adminUser.id,
    },
  });

  // Two services in two different commission groups so the engine has to
  // produce at least two snapshots per commission type.
  const skinService = await prisma.service.create({
    data: {
      code: `SKIN-CRW-${stamp}`,
      name: `Skin Smoke ${stamp}`,
      commissionGroupCode: ServiceGroupCode.RATE_SKIN,
      basePrice: 1000,
    },
  });
  const hairService = await prisma.service.create({
    data: {
      code: `HAIR-CRW-${stamp}`,
      name: `Hair Smoke ${stamp}`,
      commissionGroupCode: ServiceGroupCode.RATE_HAIR,
      basePrice: 1000,
    },
  });

  // Sales order: 1× skin @ 3,000 + 2× hair @ 2,500 = 8,000 total.
  // depositRequired = 4,000 so a single 4,000 deposit payment trips the
  // satisfied-deposit hook on its first try.
  const order = await prisma.salesOrder.create({
    data: {
      orderNo: `SO-CRW-${stamp}`,
      branchId: branch.id,
      customerId: customer.id,
      leadId: lead.id,
      createdByUserId: adminUser.id,
      status: SalesOrderStatus.CONFIRMED,
      subtotalAmount: 8000,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 8000,
      depositRequired: 4000,
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

  // Booked appointment so SALES_COMMISSION eligibility (appointment OR
  // service event) passes.
  await prisma.appointment.create({
    data: {
      appointmentNo: `APT-CRW-${stamp}`,
      branchId: branch.id,
      salesOrderId: order.id,
      customerId: customer.id,
      serviceId: skinService.id,
      createdByUserId: adminUser.id,
      scheduledAt: new Date(Date.now() + 86400000),
      status: 'BOOKED',
    },
  });

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ── 1. Bulk-upsert tier ladders for BOTH commission types ──
  // Skin: SALES_COMMISSION FIXED 50 ≥ 2001
  // Hair: SALES_COMMISSION PERCENTAGE 0.03 ≥ 5000
  // Skin: LEAD_REWARD     FIXED 30 ≥ 1
  // Hair: LEAD_REWARD     FIXED 100 ≥ 1
  console.log('\n── 1. Bulk upsert tier ladders ──');
  const sales = unwrap(
    await call<BulkUpsertResp>(
      'POST',
      '/commission-rules/bulk-upsert',
      {
        bundles: [
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_SKIN',
            commissionType: 'SALES_COMMISSION',
            tiers: [
              { minimum: 1, rate: 30, type: 'FIXED' },
              { minimum: 2001, rate: 50, type: 'FIXED' },
            ],
          },
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_HAIR',
            commissionType: 'SALES_COMMISSION',
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
  expect(
    sales.bundlesUpdated === 2 && sales.tiersWritten === 4,
    'sales bundles upserted (2 bundles / 4 tiers)',
  );
  const reward = unwrap(
    await call<BulkUpsertResp>(
      'POST',
      '/commission-rules/bulk-upsert',
      {
        bundles: [
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_SKIN',
            commissionType: 'LEAD_REWARD',
            tiers: [{ minimum: 1, rate: 30, type: 'FIXED' }],
          },
          {
            branchId: branch.id,
            serviceGroupCode: 'RATE_HAIR',
            commissionType: 'LEAD_REWARD',
            tiers: [{ minimum: 1, rate: 100, type: 'FIXED' }],
          },
        ],
      },
      token,
    ),
  );
  expect(
    reward.bundlesUpdated === 2 && reward.tiersWritten === 2,
    'lead-reward bundles upserted',
  );

  // ── 2. Pay deposit → wallet credit + auto evaluate ──
  console.log(
    '\n── 2. Deposit payment triggers wallet credit + commission evaluate ──',
  );
  const payResp = unwrap(
    await call<{
      id: string;
      paidAt: string;
      salesOrder: { depositSatisfiedAt: string | null; status: string };
    }>(
      'POST',
      '/payments',
      {
        salesOrderId: order.id,
        amount: 4000,
        paymentMethod: 'CASH',
        paymentType: 'DEPOSIT',
        note: 'CRW deposit',
      },
      token,
    ),
  );
  expect(
    payResp.salesOrder.depositSatisfiedAt !== null,
    'deposit payment satisfies depositRequired',
  );

  // Wallet auto-created and credited via integration hook.
  const wallets = unwrap(
    await call<WalletResp[]>(
      'GET',
      `/wallet/customer/${customer.id}`,
      undefined,
      token,
    ),
  );
  const depositWallet = wallets.find((w) => w.type === 'DEPOSIT');
  expect(!!depositWallet, 'DEPOSIT wallet auto-created on first credit');
  expect(
    num(depositWallet!.balance) === 4000,
    `DEPOSIT wallet balance = 4000 (got ${depositWallet?.balance})`,
  );
  const paymentTxn = await prisma.walletTransaction.findFirst({
    where: {
      walletId: depositWallet!.id,
      referenceType: 'PAYMENT',
      referenceId: payResp.id,
    },
  });
  expect(
    paymentTxn !== null && Number(paymentTxn!.amount.toString()) === 4000,
    'wallet ledger has CREDIT row referencing the payment',
  );

  // Commissions auto-created by the engine. Skin subtotal 3,000 → tier 2001
  // wins (FIXED 50). Hair subtotal 5,000 → tier 5000 wins (PERCENTAGE 0.03
  // → 5,000 × 0.03 = 150).
  const orderCommissions = unwrap(
    await call<{ data: CommissionResp[]; meta: { total: number } }>(
      'GET',
      `/commissions?salesOrderId=${order.id}`,
      undefined,
      token,
    ),
  );
  expect(
    orderCommissions.data.length === 4,
    `auto-evaluate created 4 commissions (2 groups × 2 types), got ${orderCommissions.data.length}`,
  );
  expect(
    orderCommissions.data.every((c) => c.status === 'ELIGIBLE'),
    'all commissions are in ELIGIBLE status',
  );
  expect(
    orderCommissions.data.every(
      (c) => c.snapshot.snapshotBranchName === branch.name,
    ),
    'snapshot freezes branch name',
  );
  expect(
    orderCommissions.data.every(
      (c) => c.snapshot.snapshotSaleCreatorName === adminUser.fullName,
    ),
    'snapshot freezes sale creator',
  );

  // SALES_COMMISSION recipients = saleCreator (admin); LEAD_REWARD
  // recipients = leadOwner. Verify split.
  const sales_skin = orderCommissions.data.find(
    (c) =>
      c.type === 'SALES_COMMISSION' &&
      c.snapshot.serviceGroupCode === 'RATE_SKIN',
  );
  const sales_hair = orderCommissions.data.find(
    (c) =>
      c.type === 'SALES_COMMISSION' &&
      c.snapshot.serviceGroupCode === 'RATE_HAIR',
  );
  const lead_skin = orderCommissions.data.find(
    (c) =>
      c.type === 'LEAD_REWARD' &&
      c.snapshot.serviceGroupCode === 'RATE_SKIN',
  );
  const lead_hair = orderCommissions.data.find(
    (c) =>
      c.type === 'LEAD_REWARD' &&
      c.snapshot.serviceGroupCode === 'RATE_HAIR',
  );
  expect(
    !!sales_skin && !!sales_hair && !!lead_skin && !!lead_hair,
    'all four (group × type) snapshots present',
  );

  // FIXED tier on skin (highest matching minimum 2001 → rate 50).
  expect(
    num(sales_skin!.amount) === 50,
    `SALES_COMMISSION × RATE_SKIN = 50 (highest tier ≥ 3000), got ${sales_skin!.amount}`,
  );
  // PERCENTAGE tier on hair: 5,000 × 0.03 = 150.
  expect(
    num(sales_hair!.amount) === 150,
    `SALES_COMMISSION × RATE_HAIR = 150 (5000 × 0.03), got ${sales_hair!.amount}`,
  );
  expect(
    num(lead_skin!.amount) === 30 && num(lead_hair!.amount) === 100,
    'LEAD_REWARD amounts match the FIXED ladder rates',
  );

  expect(
    sales_skin!.recipientUserId === adminUser.id,
    'SALES_COMMISSION recipient = order creator (admin)',
  );
  expect(
    lead_skin!.recipientUserId === leadOwner.id,
    'LEAD_REWARD recipient = lead.currentOwner',
  );
  expect(
    lead_skin!.snapshot.snapshotLeadOwnerName === leadOwner.fullName,
    'snapshot freezes lead owner name',
  );

  // ── 4. Idempotency ──
  console.log('\n── 4. Re-evaluation is idempotent ──');
  const reEval = unwrap(
    await call<EvaluateResp>(
      'POST',
      `/commissions/evaluate/${order.id}`,
      undefined,
      token,
    ),
  );
  expect(
    reEval.createdCount === 0 && reEval.skippedExistingCount === 4,
    `re-eval creates 0 / skips 4 (got created=${reEval.createdCount}, skipped=${reEval.skippedExistingCount})`,
  );

  // ── 5. Lock + Pay one commission ──
  console.log('\n── 5. Lock + Pay lifecycle ──');
  const locked = unwrap(
    await call<CommissionResp>(
      'POST',
      `/commissions/${sales_skin!.id}/lock`,
      { note: 'period close' },
      token,
    ),
  );
  expect(locked.status === 'LOCKED', 'lock transitions ELIGIBLE → LOCKED');

  const lockNonEligible = await call(
    'POST',
    `/commissions/${locked.id}/lock`,
    {},
    token,
  );
  expect(
    lockNonEligible.status === 409,
    'locking a LOCKED commission returns 409',
  );

  const paid = unwrap(
    await call<CommissionResp>(
      'POST',
      `/commissions/${sales_skin!.id}/pay`,
      { note: 'payroll run 2026-05' },
      token,
    ),
  );
  expect(paid.status === 'PAID', 'pay transitions LOCKED → PAID');

  const payNonLocked = await call(
    'POST',
    `/commissions/${sales_hair!.id}/pay`,
    {},
    token,
  );
  expect(payNonLocked.status === 409, 'paying an ELIGIBLE commission → 409');

  // ── 6. Refund: amount validation ──
  console.log('\n── 6. Refund amount validation ──');
  const overRefund = await call(
    'POST',
    '/refunds',
    {
      salesOrderId: order.id,
      amount: 5000, // paid is 4000
      refundType: 'PARTIAL_REFUND',
      reason: 'over-amount test',
    },
    token,
  );
  expect(
    overRefund.status === 400,
    'refund amount > paid sum is rejected (400)',
  );

  // ── 7. Refund happy path: create → approve → complete ──
  console.log('\n── 7. Refund happy path ──');
  const refund = unwrap(
    await call<RefundResp>(
      'POST',
      '/refunds',
      {
        salesOrderId: order.id,
        amount: 1500,
        refundType: 'PARTIAL_REFUND',
        reason: 'customer changed mind',
      },
      token,
    ),
  );
  expect(refund.status === 'REQUESTED', 'refund created in REQUESTED');
  expect(
    /^RFD-\d{8}-\d{4}$/.test(refund.refundNo),
    `refundNo matches RFD-YYYYMMDD-#### pattern (got ${refund.refundNo})`,
  );

  // Cannot complete from REQUESTED (must approve first).
  const completeBeforeApprove = await call(
    'POST',
    `/refunds/${refund.id}/complete`,
    {},
    token,
  );
  expect(
    completeBeforeApprove.status === 409,
    'completing a REQUESTED refund returns 409 (must be APPROVED)',
  );

  const approved = unwrap(
    await call<RefundResp>(
      'POST',
      `/refunds/${refund.id}/approve`,
      {},
      token,
    ),
  );
  expect(approved.status === 'APPROVED', 'refund approved');
  expect(
    approved.approvedByUserId === adminUser.id,
    'approvedByUserId stamped',
  );
  expect(approved.approvedAt !== null, 'approvedAt stamped');

  const balanceBefore = depositWallet!.balance;
  const completed = unwrap(
    await call<RefundResp>(
      'POST',
      `/refunds/${refund.id}/complete`,
      {},
      token,
    ),
  );
  expect(completed.status === 'COMPLETED', 'refund completed');
  expect(completed.completedAt !== null, 'completedAt stamped');

  // Wallet credited by completion.
  const walletsAfter = unwrap(
    await call<WalletResp[]>(
      'GET',
      `/wallet/customer/${customer.id}`,
      undefined,
      token,
    ),
  );
  const depAfter = walletsAfter.find((w) => w.type === 'DEPOSIT');
  expect(
    num(depAfter!.balance) === num(balanceBefore) + 1500,
    `wallet credited by refund amount (1500) — before ${balanceBefore}, after ${depAfter!.balance}`,
  );
  const refundTxn = await prisma.walletTransaction.findFirst({
    where: {
      walletId: depAfter!.id,
      referenceType: 'REFUND',
      referenceId: refund.id,
    },
  });
  expect(refundTxn !== null, 'wallet ledger has CREDIT row referencing refund');

  // Commission revoke: PAID stays, all others REVOKED.
  const afterRefund = unwrap(
    await call<{ data: CommissionResp[] }>(
      'GET',
      `/commissions?salesOrderId=${order.id}`,
      undefined,
      token,
    ),
  );
  const stillPaid = afterRefund.data.find((c) => c.id === sales_skin!.id);
  expect(stillPaid!.status === 'PAID', 'PAID commission survives refund');
  const revokedRows = afterRefund.data.filter((c) => c.status === 'REVOKED');
  expect(
    revokedRows.length === 3,
    `3 non-PAID commissions revoked (got ${revokedRows.length})`,
  );
  const revokedDb = await prisma.commission.findFirst({
    where: { id: revokedRows[0].id },
    select: { revokedByRefundId: true, revokedReason: true },
  });
  expect(
    revokedDb!.revokedByRefundId === refund.id,
    'revokedByRefundId points back to the refund',
  );
  expect(
    revokedDb!.revokedReason !== null && revokedDb!.revokedReason!.length > 0,
    'revokedReason is populated',
  );

  // ── 8. Wallet APIs ──
  console.log('\n── 8. Wallet credit / debit / transfer ──');
  // Credit (manual).
  const credit = unwrap(
    await call<WalletTxnResp>(
      'POST',
      '/wallet/credit',
      {
        customerId: customer.id,
        walletType: 'VOUCHER',
        amount: 500,
        note: 'gift voucher',
      },
      token,
    ),
  );
  expect(
    num(credit.wallet.balance) === 500,
    'voucher wallet auto-created, balance = 500',
  );

  // Debit happy path.
  const debit = unwrap(
    await call<WalletTxnResp>(
      'POST',
      '/wallet/debit',
      {
        customerId: customer.id,
        walletType: 'VOUCHER',
        amount: 200,
        note: 'redeem',
      },
      token,
    ),
  );
  expect(num(debit.wallet.balance) === 300, 'debit reduces balance to 300');
  expect(
    num(debit.transaction.balanceBefore) === 500 &&
      num(debit.transaction.balanceAfter) === 300,
    'debit ledger entry has correct before/after',
  );

  // Debit refused on insufficient balance — voucher has 300, asking 500.
  const debitOver = await call(
    'POST',
    '/wallet/debit',
    {
      customerId: customer.id,
      walletType: 'VOUCHER',
      amount: 500,
    },
    token,
  );
  expect(
    debitOver.status === 400,
    'wallet debit beyond balance returns 400 (no negatives)',
  );

  // Transfer: voucher → deposit (same customer).
  const transfer = unwrap(
    await call<{ out: WalletTxnResp; in: WalletTxnResp }>(
      'POST',
      '/wallet/transfer',
      {
        fromCustomerId: customer.id,
        toCustomerId: customer.id,
        fromWalletType: 'VOUCHER',
        toWalletType: 'DEPOSIT',
        amount: 100,
      },
      token,
    ),
  );
  expect(
    num(transfer.out.wallet.balance) === 200,
    'transfer source wallet debited (300 → 200)',
  );
  expect(
    num(transfer.in.wallet.balance) === num(depAfter!.balance) + 100,
    'transfer target wallet credited',
  );

  // ── 9. Audit trail spot-check ──
  console.log('\n── 9. Audit logs ──');
  const auditRows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entityType: 'Commission' },
        { entityType: 'Refund', entityId: refund.id },
        { entityType: 'Wallet' },
      ],
      createdAt: { gte: new Date(Date.now() - 600_000) },
    },
    select: { entityType: true, action: true, payload: true },
  });
  const ops = new Set(
    auditRows.map((r) => {
      const p = r.payload as { op?: string } | null;
      return `${r.entityType}|${r.action}|${p?.op ?? ''}`;
    }),
  );
  expect(
    ops.has('Commission|CREATE|evaluate'),
    'audit row: Commission CREATE op=evaluate',
  );
  expect(
    ops.has('Commission|UPDATE|lock'),
    'audit row: Commission UPDATE op=lock',
  );
  expect(
    ops.has('Commission|PAY|pay'),
    'audit row: Commission PAY op=pay',
  );
  expect(
    ops.has('Commission|UPDATE|revoke'),
    'audit row: Commission UPDATE op=revoke (from refund)',
  );
  expect(
    ops.has('Refund|APPROVE|approve'),
    'audit row: Refund APPROVE op=approve',
  );
  expect(
    ops.has('Refund|COMPLETE|complete'),
    'audit row: Refund COMPLETE op=complete',
  );
  expect(
    ops.has('Wallet|UPDATE|credit'),
    'audit row: Wallet UPDATE op=credit',
  );
  expect(
    ops.has('Wallet|UPDATE|debit'),
    'audit row: Wallet UPDATE op=debit',
  );

  console.log('\n✅ commission + refund + wallet smoke OK');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ smoke FAILED:', err);
  process.exit(1);
});
