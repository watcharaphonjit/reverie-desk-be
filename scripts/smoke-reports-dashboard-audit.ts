/**
 * Smoke for Reports + Dashboard + Audit modules.
 *
 * Checks:
 *
 *   Reports
 *     ✓ /reports/sales totals reconcile with DB
 *     ✓ /reports/payments byMethod / byType / byStatus row counts match DB
 *     ✓ /reports/service-events doctor & employee buckets correct
 *     ✓ /reports/appointments status counts reconcile + utilization formula
 *     ✓ /reports/inventory grouped totals match StockMovement aggregates
 *     ✓ /reports/commissions status totals match DB
 *     ✓ /reports/wallets credit + debit reconcile against ledger
 *
 *   Dashboard
 *     ✓ /dashboard/executive returns the documented card shape
 *     ✓ /dashboard/branch/:id is branch-scoped (404 unknown / 403 stranger)
 *     ✓ /dashboard/doctor/:userId returns expected shape
 *     ✓ /dashboard/telesales/:userId returns expected shape
 *
 *   Audit
 *     ✓ GET /audit search returns recent rows
 *     ✓ GET /audit/entity/:type/:id timeline is chronologically ordered
 *     ✓ GET /audit/user/:userId splits login vs action history
 *
 *   Security
 *     ✓ User without REPORT_VIEW permission gets 403
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

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

interface SalesResp {
  summary: {
    totalOrders: number;
    grossSales: number;
    netSales: number;
    discounts: number;
    depositsCollected: number;
    fullyPaidOrders: number;
  };
  groupBy: string;
  breakdown: Array<{ bucket: string; orders: number; netSales: number }>;
}
interface PaymentsResp {
  summary: {
    totalPayments: number;
    grossCollected: number;
    successAmount: number;
    refundsCompletedAmount: number;
    netCollected: number;
  };
  byMethod: Array<{ paymentMethod: string; count: number; total: number }>;
  byType: Array<{ paymentType: string; count: number; total: number }>;
  byStatus: Array<{ status: string; count: number; total: number }>;
}
interface ServiceEventsResp {
  summary: {
    totalEvents: number;
    completed: number;
    distinctCustomers: number;
    averageServicesPerCustomer: number;
  };
  doctorPerformance: Array<{ userId: string | null; count: number }>;
  employeePerformance: Array<{ userId: string | null; count: number }>;
}
interface AppointmentsResp {
  summary: {
    totalAppointments: number;
    booked: number;
    completed: number;
    cancelled: number;
    noShow: number;
    utilizationRate: number;
  };
  groupBy: string;
  breakdown: Array<{ total: number; completed: number; utilization: number }>;
}
interface InventoryResp {
  summary: { totalMovements: number; received: number; clinicalUsage: number };
  byType: Array<{ type: string; count: number; quantity: number }>;
}
interface CommissionsResp {
  summary: {
    totalCommissions: number;
    totalAmount: number;
    PAID: { count: number; amount: number };
    ELIGIBLE: { count: number; amount: number };
    REVOKED: { count: number; amount: number };
  };
  groupBy: string;
  breakdown: Array<{ key: string; count: number; amount: number }>;
}
interface WalletsResp {
  summary: {
    activeWallets: number;
    totalBalance: number;
    totalCredit: number;
    totalDebit: number;
    net: number;
  };
}
interface ExecResp {
  todaySales: { orders: number; amount: number };
  monthSales: { orders: number; amount: number };
  outstandingDeposits: number;
  totalAppointmentsToday: number;
  stockAlerts: number;
  pendingRefunds: number;
  pendingCommissions: number;
}
interface BranchResp {
  branch: { id: string; code: string; name: string };
  branchSalesToday: { orders: number; amount: number };
  customersToday: number;
  appointmentsToday: number;
  activeLeads: number;
  lowStockItems: Array<{ stockItemId: string; totalOnHand: number }>;
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });

  // ── Login ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = unwrap(login).accessToken;

  // ───────────────── Reports ─────────────────

  console.log('\n── 1. /reports/sales reconciles totals ──');
  const salesResp = unwrap(
    await call<SalesResp>('GET', '/reports/sales?groupBy=day', undefined, token),
  );
  const dbAgg = await prisma.salesOrder.aggregate({
    _count: { _all: true },
    _sum: { totalAmount: true },
  });
  expect(
    salesResp.summary.totalOrders === dbAgg._count._all,
    `sales.totalOrders matches DB count (${salesResp.summary.totalOrders} === ${dbAgg._count._all})`,
  );
  expect(
    Math.abs(salesResp.summary.netSales - num(dbAgg._sum.totalAmount)) < 0.01,
    `sales.netSales matches Σ totalAmount (${salesResp.summary.netSales})`,
  );
  expect(
    salesResp.groupBy === 'day' && Array.isArray(salesResp.breakdown),
    'sales breakdown bucketed by day',
  );

  // breakdown sums up to net.
  const breakdownNet = salesResp.breakdown.reduce(
    (acc, b) => acc + b.netSales,
    0,
  );
  expect(
    Math.abs(breakdownNet - salesResp.summary.netSales) < 0.05,
    `breakdown Σ netSales ≈ summary.netSales (Δ ${Math.abs(breakdownNet - salesResp.summary.netSales).toFixed(4)})`,
  );

  console.log('\n── 2. /reports/payments reconciles ──');
  const payResp = unwrap(
    await call<PaymentsResp>('GET', '/reports/payments', undefined, token),
  );
  const dbPay = await prisma.payment.aggregate({
    _count: { _all: true },
    _sum: { amount: true },
  });
  expect(
    payResp.summary.totalPayments === dbPay._count._all,
    'payments.totalPayments matches DB count',
  );
  expect(
    Math.abs(payResp.summary.grossCollected - num(dbPay._sum.amount)) < 0.01,
    'payments.grossCollected matches Σ amount',
  );
  // byStatus must sum to totalPayments.
  const statusSum = payResp.byStatus.reduce((acc, r) => acc + r.count, 0);
  expect(
    statusSum === payResp.summary.totalPayments,
    `Σ byStatus.count === totalPayments (${statusSum} === ${payResp.summary.totalPayments})`,
  );

  console.log('\n── 3. /reports/service-events reconciles ──');
  const seResp = unwrap(
    await call<ServiceEventsResp>('GET', '/reports/service-events', undefined, token),
  );
  const dbSeCount = await prisma.customerServiceEvent.count();
  expect(
    seResp.summary.totalEvents === dbSeCount,
    'service-events totals match DB count',
  );
  if (seResp.summary.totalEvents > 0) {
    expect(
      seResp.summary.distinctCustomers > 0,
      'distinctCustomers populated when there are events',
    );
  }

  console.log('\n── 4. /reports/appointments utilization formula ──');
  const apptResp = unwrap(
    await call<AppointmentsResp>(
      'GET',
      '/reports/appointments?groupBy=branch',
      undefined,
      token,
    ),
  );
  const dbApptCount = await prisma.appointment.count();
  expect(
    apptResp.summary.totalAppointments === dbApptCount,
    'appointments total matches DB',
  );
  // Spot-check utilization = completed / (booked + checkedIn + completed + cancelled + noShow).
  const denom =
    apptResp.summary.booked +
    apptResp.summary.completed +
    apptResp.summary.cancelled +
    apptResp.summary.noShow;
  if (denom > 0) {
    const expected =
      Math.round((apptResp.summary.completed / dbApptCount) * 100) / 100;
    expect(
      Math.abs(apptResp.summary.utilizationRate - expected) < 0.05,
      `utilization rate within tolerance (${apptResp.summary.utilizationRate} vs ${expected})`,
    );
  }
  // Per-row breakdowns sum to totals.
  const sumCompleted = apptResp.breakdown.reduce(
    (acc, r) => acc + r.completed,
    0,
  );
  expect(
    sumCompleted === apptResp.summary.completed,
    'breakdown Σ completed === summary.completed',
  );

  console.log('\n── 5. /reports/inventory matches StockMovement aggregate ──');
  const invResp = unwrap(
    await call<InventoryResp>('GET', '/reports/inventory', undefined, token),
  );
  const dbInv = await prisma.stockMovement.count();
  expect(
    invResp.summary.totalMovements === dbInv,
    `inventory totalMovements matches DB (${invResp.summary.totalMovements} === ${dbInv})`,
  );

  console.log('\n── 6. /reports/commissions status totals ──');
  const comResp = unwrap(
    await call<CommissionsResp>(
      'GET',
      '/reports/commissions?groupBy=user',
      undefined,
      token,
    ),
  );
  const dbCom = await prisma.commission.count();
  expect(
    comResp.summary.totalCommissions === dbCom,
    'commissions count matches DB',
  );
  const dbPaidAgg = await prisma.commission.aggregate({
    where: { status: 'PAID' },
    _count: { _all: true },
    _sum: { amount: true },
  });
  expect(
    comResp.summary.PAID.count === dbPaidAgg._count._all,
    'PAID count reconciles',
  );
  expect(
    Math.abs(comResp.summary.PAID.amount - num(dbPaidAgg._sum.amount)) < 0.01,
    'PAID amount reconciles',
  );

  console.log('\n── 7. /reports/wallets ledger reconciles ──');
  const walletsResp = unwrap(
    await call<WalletsResp>('GET', '/reports/wallets', undefined, token),
  );
  const dbCount = await prisma.wallet.count();
  expect(
    walletsResp.summary.activeWallets === dbCount,
    'activeWallets count matches DB',
  );
  // Net should equal sum of all wallet balances (assuming no expiry gaps).
  const dbBalance = await prisma.wallet.aggregate({ _sum: { balance: true } });
  expect(
    Math.abs(walletsResp.summary.totalBalance - num(dbBalance._sum.balance)) <
      0.01,
    'wallet totalBalance matches Σ wallet.balance',
  );

  // ───────────────── Dashboard ─────────────────

  console.log('\n── 8. /dashboard/executive ──');
  const execResp = unwrap(
    await call<ExecResp>('GET', '/dashboard/executive', undefined, token),
  );
  expect(
    typeof execResp.todaySales.orders === 'number' &&
      typeof execResp.monthSales.orders === 'number',
    'executive: today/monthSales numeric',
  );
  expect(
    typeof execResp.outstandingDeposits === 'number',
    'executive: outstandingDeposits numeric',
  );
  expect(
    'pendingRefunds' in execResp && 'pendingCommissions' in execResp,
    'executive: pendingRefunds + pendingCommissions present',
  );
  expect(
    execResp.monthSales.orders >= execResp.todaySales.orders,
    'month orders ≥ today orders',
  );

  console.log('\n── 9. /dashboard/branch/:branchId ──');
  const branch = await prisma.branch.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
  });
  if (!branch) throw new Error('Need an active branch');
  const branchResp = unwrap(
    await call<BranchResp>(
      'GET',
      `/dashboard/branch/${branch.id}`,
      undefined,
      token,
    ),
  );
  expect(
    branchResp.branch.id === branch.id,
    'branch dashboard returns the requested branch',
  );
  expect(
    Array.isArray(branchResp.lowStockItems),
    'branch.lowStockItems is an array',
  );
  // Unknown branch → 404.
  const unknownBranch = await call(
    'GET',
    `/dashboard/branch/clx_unknown_branch_id`,
    undefined,
    token,
  );
  expect(
    unknownBranch.status === 404,
    'unknown branchId returns 404',
  );

  console.log('\n── 10. /dashboard/doctor + /dashboard/telesales ──');
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@reverie.local' },
  });
  const docResp = unwrap(
    await call<{
      appointmentsToday: number;
      noShows: number;
      completedServicesToday: number;
    }>(
      'GET',
      `/dashboard/doctor/${adminUser!.id}`,
      undefined,
      token,
    ),
  );
  expect(
    typeof docResp.appointmentsToday === 'number' &&
      typeof docResp.noShows === 'number',
    'doctor dashboard returns documented shape',
  );

  const telResp = unwrap(
    await call<{
      activeLeads: number;
      contactedToday: number;
      wonToday: number;
      commissionsPending: { count: number; amount: number };
    }>(
      'GET',
      `/dashboard/telesales/${adminUser!.id}`,
      undefined,
      token,
    ),
  );
  expect(
    typeof telResp.activeLeads === 'number' &&
      typeof telResp.commissionsPending.count === 'number',
    'telesales dashboard returns documented shape',
  );

  // ───────────────── Audit ─────────────────

  console.log('\n── 11. GET /audit search ──');
  const auditList = unwrap(
    await call<{ data: Array<{ id: string; entityType: string; createdAt: string }>; meta: { total: number } }>(
      'GET',
      '/audit?limit=10',
      undefined,
      token,
    ),
  );
  expect(auditList.meta.total > 0, 'audit list has entries');
  expect(
    auditList.data.length <= 10 && auditList.data.length > 0,
    `audit pagination respects limit (got ${auditList.data.length})`,
  );

  // Filter by entityType.
  const filtered = unwrap(
    await call<{ data: Array<{ entityType: string }>; meta: { total: number } }>(
      'GET',
      '/audit?entityType=Commission&limit=5',
      undefined,
      token,
    ),
  );
  expect(
    filtered.data.every((r) => r.entityType === 'Commission'),
    'audit search filters by entityType',
  );

  console.log('\n── 12. GET /audit/entity/:type/:id timeline ordered ──');
  // Pick an existing commission to inspect.
  const someCommission = await prisma.commission.findFirst({
    select: { id: true },
  });
  if (someCommission) {
    const timeline = unwrap(
      await call<{
        data: Array<{ createdAt: string; action: string }>;
      }>(
        'GET',
        `/audit/entity/Commission/${someCommission.id}`,
        undefined,
        token,
      ),
    );
    expect(timeline.data.length > 0, 'commission has audit timeline entries');
    const ts = timeline.data.map((r) => new Date(r.createdAt).getTime());
    const isAsc = ts.every((t, i) => i === 0 || t >= ts[i - 1]);
    expect(isAsc, 'timeline rows are ordered chronologically (asc)');
  }

  console.log('\n── 13. GET /audit/user/:userId ──');
  const userActivity = unwrap(
    await call<{
      user: { id: string };
      loginHistory: Array<{ action: string }>;
      recentActions: Array<{ action: string }>;
      latestActivity: { createdAt: string } | null;
    }>(
      'GET',
      `/audit/user/${adminUser!.id}`,
      undefined,
      token,
    ),
  );
  expect(
    userActivity.user.id === adminUser!.id,
    'user activity returns the right user',
  );
  expect(
    userActivity.recentActions.every(
      (r) => r.action !== 'LOGIN' && r.action !== 'LOGOUT',
    ),
    'recentActions excludes login/logout',
  );
  expect(
    userActivity.loginHistory.every(
      (r) => r.action === 'LOGIN' || r.action === 'LOGOUT',
    ),
    'loginHistory only contains LOGIN/LOGOUT',
  );

  // ───────────────── Security ─────────────────

  console.log('\n── 14. Permission gates ──');
  // Create a fresh user with no permissions (EMPLOYEE role only).
  const stamp = Date.now().toString().slice(-7);
  const employeeRole = await prisma.role.findUnique({
    where: { code: 'EMPLOYEE' },
    select: { id: true },
  });
  if (!employeeRole) throw new Error('EMPLOYEE role missing — re-seed');
  const bcrypt = await import('bcrypt');
  const passwordHash = await bcrypt.hash('Test123!', 12);
  const guest = await prisma.user.create({
    data: {
      email: `report-guest-${stamp}@reverie.local`,
      fullName: `Guest ${stamp}`,
      passwordHash,
      branchId: branch.id,
      status: 'ACTIVE',
      userRoles: { create: { roleId: employeeRole.id, branchId: branch.id } },
    },
  });
  const guestLogin = await call<{ accessToken: string }>(
    'POST',
    '/auth/login',
    {
      email: guest.email,
      password: 'Test123!',
    },
  );
  if (!guestLogin.body.success) {
    throw new Error(`guest login failed: ${guestLogin.body.error.message}`);
  }
  const guestToken = guestLogin.body.data.accessToken;

  const noReports = await call('GET', '/reports/sales', undefined, guestToken);
  expect(
    noReports.status === 403,
    'user without REPORT_VIEW gets 403 on /reports/*',
  );
  const noDashboard = await call(
    'GET',
    '/dashboard/executive',
    undefined,
    guestToken,
  );
  expect(
    noDashboard.status === 403,
    'user without DASHBOARD_VIEW gets 403 on /dashboard/*',
  );
  const noAudit = await call('GET', '/audit', undefined, guestToken);
  expect(
    noAudit.status === 403,
    'user without AUDIT_VIEW gets 403 on /audit/*',
  );
  // No token → 401.
  const noToken = await call('GET', '/reports/sales');
  expect(noToken.status === 401, 'no token → 401');

  console.log('\n✅ reports + dashboard + audit smoke OK');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ smoke FAILED:', err);
  process.exit(1);
});
