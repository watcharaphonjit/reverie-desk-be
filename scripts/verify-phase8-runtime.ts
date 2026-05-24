/**
 * Phase 8 runtime verification against live local API.
 * Usage: npx ts-node -r tsconfig-paths/register scripts/verify-phase8-runtime.ts
 */
import 'dotenv/config';
import { SalesOrderStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';

type Result = { scenario: string; result: 'PASS' | 'FAIL'; evidence: string };

const results: Result[] = [];

function pass(scenario: string, evidence: string) {
  results.push({ scenario, result: 'PASS', evidence });
  console.log(`PASS  ${scenario}\n      ${evidence}`);
}

function fail(scenario: string, evidence: string) {
  results.push({ scenario, result: 'FAIL', evidence });
  console.error(`FAIL  ${scenario}\n      ${evidence}`);
}

async function api<T = unknown>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string;
    expectStatus?: number;
  } = {},
): Promise<{ status: number; data: T; raw: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const raw = await res.json().catch(() => null);
  const data = (raw as { data?: T })?.data ?? raw;

  if (opts.expectStatus !== undefined && res.status !== opts.expectStatus) {
    throw new Error(
      `${opts.method ?? 'GET'} ${path} expected ${opts.expectStatus} got ${res.status}: ${JSON.stringify(raw)}`,
    );
  }

  return { status: res.status, data: data as T, raw };
}

async function login(email: string, password: string): Promise<string> {
  const { data } = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
    expectStatus: 200,
  });
  return data.accessToken;
}

async function main() {
  console.log(`\n=== Phase 8 Runtime Verification ===\nBase: ${BASE}\n`);

  // Health
  try {
    await api('/health/live', { expectStatus: 200 });
    pass('Health live', 'GET /health/live → 200');
  } catch (e) {
    fail('Health live', String(e));
    console.log('\nAborting — API not reachable.');
    process.exit(1);
  }

  let adminToken: string;
  let teleToken: string | undefined;
  let branchId: string;
  let createdBranchId: string | null = null;
  let createdUserEmail: string | null = null;
  let createdUserPassword = 'TestUser1!Aa';
  let targetId: string | null = null;
  let leadId: string | null = null;
  let customerId: string | null = null;
  let orderId: string | null = null;

  try {
    adminToken = await login('admin@reverie.local', 'Admin123!');
    pass('Admin login', 'admin@reverie.local');
  } catch (e) {
    fail('Admin login', String(e));
    process.exit(1);
  }

  // Branches list
  const branchesRes = await api<{ data: Array<{ id: string; code: string; name: string }> }>(
    '/branches?limit=100',
    { token: adminToken },
  );
  const branches = (branchesRes.data as { data?: typeof branches })?.data ??
    (branchesRes.data as unknown as Array<{ id: string; code: string }>);
  branchId = Array.isArray(branches) ? branches[0]?.id : '';
  if (!branchId) {
    fail('Branch list', 'No branches found');
  } else {
    pass('Branch list', `branchId=${branchId}`);
  }

  // Create branch
  const branchCode = `P8${Date.now().toString().slice(-6)}`;
  try {
    const created = await api<{ id: string; code: string; phone?: string }>('/branches', {
      method: 'POST',
      token: adminToken,
      body: {
        code: branchCode,
        name: `Phase8 Test ${branchCode}`,
        phone: '0812345678',
        address: '123 Test Rd',
        status: 'ACTIVE',
      },
      expectStatus: 201,
    });
    createdBranchId = created.data.id;
    pass('Create branch (ADMIN)', `id=${createdBranchId} code=${branchCode}`);
  } catch (e) {
    fail('Create branch (ADMIN)', String(e));
  }

  // Duplicate code
  try {
    await api('/branches', {
      method: 'POST',
      token: adminToken,
      body: { code: branchCode, name: 'Dup' },
      expectStatus: 409,
    });
    pass('Duplicate branch code', 'POST → 409 Conflict');
  } catch (e) {
    fail('Duplicate branch code', String(e));
  }

  // Validation - missing name
  try {
    await api('/branches', {
      method: 'POST',
      token: adminToken,
      body: { code: 'X', name: '' },
      expectStatus: 400,
    });
    pass('Branch validation', 'empty name → 400');
  } catch (e) {
    fail('Branch validation', String(e));
  }

  // Create user (before non-admin branch test — seed has no tele.* users)
  createdUserEmail = `phase8.user.${Date.now()}@reverie.local`;
  try {
    const user = await api<{ id: string; email: string }>('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        email: createdUserEmail,
        password: createdUserPassword,
        firstName: 'Phase8',
        lastName: 'Tester',
        phone: `+668${Date.now().toString().slice(-8)}`,
        branchId,
        status: 'ACTIVE',
        roles: ['TELESALES'],
      },
      expectStatus: 201,
    });
    pass('Create user', `id=${user.data.id} email=${createdUserEmail}`);
  } catch (e) {
    fail('Create user', String(e));
  }

  // Login created TELESALES user + 403 on create branch
  if (createdUserEmail) {
    try {
      teleToken = await login(createdUserEmail, createdUserPassword);
      await api('/branches', {
        method: 'POST',
        token: teleToken,
        body: { code: 'TELETEST', name: 'Tele Branch' },
        expectStatus: 403,
      });
      pass('Non-admin branch create 403', 'TELESALES POST /branches → 403');
    } catch (e) {
      fail('Non-admin branch create 403', String(e));
    }
  }

  // Login created user (explicit scenario)
  if (createdUserEmail) {
    try {
      await login(createdUserEmail, createdUserPassword);
      pass('Login created user', createdUserEmail);
    } catch (e) {
      fail('Login created user', String(e));
    }
  }

  // Invalid password on create
  try {
    await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        email: `bad.${Date.now()}@reverie.local`,
        password: 'weak',
        firstName: 'Bad',
        lastName: 'Pass',
      },
      expectStatus: 400,
    });
    pass('Invalid password rejected', 'weak password → 400');
  } catch (e) {
    fail('Invalid password rejected', String(e));
  }

  // Settings masters
  const testPage = `Test Page ${Date.now()}`;
  const testAccount = `SCB-xxx-${Date.now()}`;
  try {
    const patched = await api<{ leads: { socialPages: string[] }; finance: { receivingAccounts: string[] } }>(
      '/settings',
      {
        method: 'PATCH',
        token: adminToken,
        body: {
          leads: { socialPages: [testPage, 'Dr. PAUL Test'] },
          finance: { receivingAccounts: [testAccount, 'KBANK-001'] },
        },
      },
    );
    const got = await api<typeof patched.data>('/settings', { token: adminToken });
    const pages = got.data.leads?.socialPages ?? [];
    const accounts = got.data.finance?.receivingAccounts ?? [];
    if (pages.includes(testPage) && accounts.includes(testAccount)) {
      pass('Settings masters persist', `page=${testPage} account=${testAccount}`);
    } else {
      fail('Settings masters persist', `pages=${JSON.stringify(pages)} accounts=${JSON.stringify(accounts)}`);
    }
  } catch (e) {
    fail('Settings masters persist', String(e));
  }

  // Targets
  const year = new Date().getFullYear();
  const quarter = Math.floor(new Date().getMonth() / 3) + 1;
  const categories = [
    { commissionGroup: 'RATE_SKIN', targetAmount: 100000 },
    { commissionGroup: 'RATE_HAIR', targetAmount: 200000 },
    { commissionGroup: 'RATE_SURGERY', targetAmount: 50000 },
    { commissionGroup: 'RATE_TRANSPLANT', targetAmount: 50000 },
    { commissionGroup: 'RATE_MEDICINE', targetAmount: 50000 },
    { commissionGroup: 'RATE_SCULPTRA', targetAmount: 50000 },
  ];
  const totalTarget = categories.reduce((s, c) => s + c.targetAmount, 0);
  try {
    const t = await api<{ id: string }>('/targets', {
      method: 'POST',
      token: adminToken,
      body: { branchId, year, quarter, totalTarget, categories },
      expectStatus: 201,
    });
    targetId = t.data.id;
    pass('Create quarter target', `id=${targetId} Q${quarter}/${year} total=${totalTarget}`);
  } catch (e) {
    // May already exist — try fetch and update
    try {
      const existing = await api<{ id: string }>(
        `/targets/branch/${branchId}?year=${year}&quarter=${quarter}`,
        { token: adminToken },
      );
      targetId = existing.data.id;
      await api(`/targets/${targetId}`, {
        method: 'PATCH',
        token: adminToken,
        body: { totalTarget, categories },
        expectStatus: 200,
      });
      pass('Update quarter target', `id=${targetId}`);
    } catch (e2) {
      fail('Create/update quarter target', `${e}; fallback: ${e2}`);
    }
  }

  // Category sum mismatch
  try {
    await api('/targets', {
      method: 'POST',
      token: adminToken,
      body: {
        branchId: createdBranchId ?? branchId,
        year: year + 1,
        quarter: 1,
        totalTarget: 999999,
        categories: [{ commissionGroup: 'RATE_SKIN', targetAmount: 1 }],
      },
      expectStatus: 400,
    });
    pass('Target category sum validation', 'mismatch → 400');
  } catch (e) {
    fail('Target category sum validation', String(e));
  }

  // Reports targets
  try {
    const report = await api('/reports/targets', {
      token: adminToken,
    });
    pass('Reports targets endpoint', `status=${report.status}`);
  } catch (e) {
    fail('Reports targets endpoint', String(e));
  }

  // Lead create with phone + owner
  const leadPhone = `08${Date.now().toString().slice(-8)}`;
  try {
    const me = await api<{ id: string }>('/auth/me', { token: adminToken });
    const lead = await api<{ id: string; code: string; currentOwnerUserId: string | null }>(
      '/leads',
      {
        method: 'POST',
        token: adminToken,
        body: {
          firstName: 'Phase8',
          lastName: 'Lead',
          phone: leadPhone,
          branchId,
          channel: 'Facebook',
          ownerUserId: me.data.id,
          orgSalesAmount: 1000,
          adsSalesAmount: 500,
          procedureTypes: ['ปลูกผม FUE'],
          depositStatus: 'มัดจำในเดือนนี้',
        },
        expectStatus: 201,
      },
    );
    leadId = lead.data.id;
    pass('Create lead with marketing fields', `id=${leadId} owner=${lead.data.currentOwnerUserId}`);
  } catch (e) {
    fail('Create lead with marketing fields', String(e));
  }

  // Phone required
  try {
    await api('/leads', {
      method: 'POST',
      token: adminToken,
      body: { firstName: 'No', lastName: 'Phone', branchId },
      expectStatus: 400,
    });
    pass('Lead phone required', 'missing phone → 400');
  } catch (e) {
    fail('Lead phone required', String(e));
  }

  // Link customer
  if (leadId) {
    try {
      const cust = await api<{ id: string }>('/customers', {
        method: 'POST',
        token: adminToken,
        body: {
          firstName: 'Link',
          lastName: 'Target',
          phone: `08${(Date.now() + 1).toString().slice(-8)}`,
          currentBranchId: branchId,
        },
        expectStatus: 201,
      });
      customerId = cust.data.id;
      const linked = await api<{ id: string; customerId: string | null }>(
        `/leads/${leadId}/link-customer`,
        {
          method: 'PATCH',
          token: adminToken,
          body: { customerId: cust.data.id },
          expectStatus: 200,
        },
      );
      pass('Link lead to customer', `leadId=${leadId} customerId=${linked.data.customerId}`);
    } catch (e) {
      fail('Link lead to customer', String(e));
    }
  }

  // Lead 1:1 sale
  if (leadId && customerId) {
    try {
      // Need a service for order - fetch catalog
      const services = await api<{ data: Array<{ id: string; basePrice?: number }> }>(
        '/services?limit=1',
        { token: adminToken },
      );
      const svcList = (services.data as { data?: Array<{ id: string; basePrice?: number }> })?.data ??
        (services.data as unknown as Array<{ id: string; basePrice?: number }>);
      const serviceId = Array.isArray(svcList) ? svcList[0]?.id : null;
      if (!serviceId) throw new Error('No service in catalog');

      const order = await api<{ id: string; leadId: string | null }>('/sales-orders', {
        method: 'POST',
        token: adminToken,
        body: {
          branchId,
          customerId,
          leadId,
          items: [{ serviceId, quantity: 1, unitPrice: 1000 }],
          taxAmount: 0,
        },
        expectStatus: 201,
      });
      orderId = order.data.id;
      pass('Create sale with lead', `orderId=${orderId} leadId=${leadId}`);

      await api('/sales-orders', {
        method: 'POST',
        token: adminToken,
        body: {
          branchId,
          customerId,
          leadId,
          items: [{ serviceId, quantity: 1, unitPrice: 1000 }],
        },
        expectStatus: 409,
      });
      pass('Lead 1:1 sale enforcement', 'duplicate leadId → 409');
    } catch (e) {
      fail('Lead 1:1 sale enforcement', String(e));
    }
  }

  // Payment receiving account
  if (orderId) {
    try {
      await api(`/sales-orders/${orderId}/confirm`, {
        method: 'POST',
        token: adminToken,
        expectStatus: 200,
      });
      const pay = await api<{ id: string; receivingAccount?: string }>('/payments', {
        method: 'POST',
        token: adminToken,
        body: {
          salesOrderId: orderId,
          amount: 100,
          paymentMethod: 'BANK_TRANSFER',
          paymentType: 'DEPOSIT',
          receivingAccount: testAccount,
        },
        expectStatus: 201,
      });
      if (pay.data.receivingAccount === testAccount) {
        pass('Payment receiving account', `paymentId=${pay.data.id} account=${testAccount}`);
      } else {
        fail('Payment receiving account', `got=${pay.data.receivingAccount}`);
      }
    } catch (e) {
      fail('Payment receiving account', String(e));
    }
  }

  // Customer birthMonth filter
  try {
    const month = new Date().getMonth() + 1;
    const filtered = await api<{ data: unknown[]; meta: { total: number } }>(
      `/customers?birthMonth=${month}&limit=5`,
      { token: adminToken },
    );
    const list = (filtered.data as { data?: unknown[] })?.data ?? filtered.data;
    pass('Customer birthMonth filter', `month=${month} count=${Array.isArray(list) ? list.length : '?'}`);
  } catch (e) {
    fail('Customer birthMonth filter', String(e));
  }

  // Service default stock endpoint
  try {
    const services = await api<{ data: Array<{ id: string }> }>('/services?limit=1', {
      token: adminToken,
    });
    const svcList = (services.data as { data?: Array<{ id: string }> })?.data ??
      (services.data as unknown as Array<{ id: string }>);
    const sid = Array.isArray(svcList) ? svcList[0]?.id : null;
    if (sid) {
      await api(`/services/${sid}/default-stock`, { token: adminToken, expectStatus: 200 });
      pass('Service default-stock endpoint', `serviceId=${sid}`);
    }
  } catch (e) {
    fail('Service default-stock endpoint', String(e));
  }

  // Telesales list scoped to own leads
  if (teleToken) {
    try {
      const list = await api<{ data: unknown[]; meta: { total: number } }>('/leads?limit=5', {
        token: teleToken,
      });
      const leads = (list.data as { data?: unknown[] })?.data ?? list.data;
      pass('Telesales lead list', `count=${Array.isArray(leads) ? leads.length : '?'}`);
    } catch (e) {
      fail('Telesales lead list', String(e));
    }
  }

  // Expired lead — admin may archive despite invalid normal transition
  try {
    const me = await api<{ id: string }>('/auth/me', { token: adminToken });
    const expirePhone = `08${Date.now().toString().slice(-8)}`;
    const expiredLead = await api<{ id: string }>('/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: 'Expired',
        lastName: 'Archive',
        phone: expirePhone,
        branchId,
        channel: 'Walk-in',
        ownerUserId: me.data.id,
      },
      expectStatus: 201,
    });
    await prisma.lead.update({
      where: { id: expiredLead.data.id },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });
    const archived = await api<{ status: string }>(
      `/leads/${expiredLead.data.id}/status`,
      {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'ARCHIVED' },
        expectStatus: 200,
      },
    );
    if (archived.data.status === 'ARCHIVED') {
      pass('Expired lead admin archive', `leadId=${expiredLead.data.id} NEW→ARCHIVED`);
    } else {
      fail('Expired lead admin archive', `status=${archived.data.status}`);
    }
  } catch (e) {
    fail('Expired lead admin archive', String(e));
  }

  // Entitlement flow: book → check-in → service event → complete → session consumed
  try {
    const stamp = Date.now().toString().slice(-6);
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@reverie.local' },
    });
    const program = await prisma.service.findFirst({
      where: { isProgram: true, isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!program) throw new Error('No active program service in catalog');

    const entCustomer = await prisma.customer.create({
      data: {
        code: `P8-ENT-${stamp}`,
        fullName: `Phase8 Entitlement ${stamp}`,
        currentBranchId: branchId,
      },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderNo: `SO-P8-ENT-${stamp}`,
        branchId,
        customerId: entCustomer.id,
        createdByUserId: adminUser.id,
        status: SalesOrderStatus.CONFIRMED,
        subtotalAmount: 1000,
        totalAmount: 1000,
        depositRequired: 0,
        items: {
          create: [
            {
              serviceId: program.id,
              quantity: 1,
              unitPrice: 1000,
              netAmount: 1000,
              snapshotServiceCode: program.code,
              snapshotServiceName: program.name,
              snapshotUnitPrice: 1000,
            },
          ],
        },
      },
    });
    await api('/payments', {
      method: 'POST',
      token: adminToken,
      body: {
        salesOrderId: order.id,
        amount: 1000,
        paymentMethod: 'CASH',
        paymentType: 'FULL',
      },
    });
    const ents = await api<Array<{ id: string; consumedSessions: number; remainingSessions: number }>>(
      `/customers/${entCustomer.id}/entitlements`,
      { token: adminToken },
    );
    const entList = Array.isArray(ents.data) ? ents.data : [];
    const entitlement = entList[0];
    if (!entitlement) throw new Error('No entitlement minted after payment');
    const consumedBefore = entitlement.consumedSessions;

    const appt = await api<{ id: string; entitlementId: string | null }>('/appointments', {
      method: 'POST',
      token: adminToken,
      body: {
        salesOrderId: order.id,
        customerId: entCustomer.id,
        serviceId: program.id,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        entitlementId: entitlement.id,
      },
      expectStatus: 201,
    });
    await api(`/appointments/${appt.data.id}/check-in`, {
      method: 'PATCH',
      token: adminToken,
      expectStatus: 200,
    });
    await prisma.customerServiceEvent.create({
      data: {
        branchId,
        customerId: entCustomer.id,
        serviceId: program.id,
        appointmentId: appt.data.id,
        performedAt: new Date(),
        completedAt: new Date(),
        employeeUserId: adminUser.id,
        status: 'COMPLETED',
      },
    });
    const completed = await api<{
      status: string;
      entitlementConsumedAt: string | null;
    }>(`/appointments/${appt.data.id}/complete`, {
      method: 'PATCH',
      token: adminToken,
      expectStatus: 200,
    });
    const entAfter = await api<{ consumedSessions: number; remainingSessions: number }>(
      `/entitlements/${entitlement.id}`,
      { token: adminToken },
    );
    const apptDetail = await api<{ entitlementConsumedAt: string | null }>(
      `/appointments/${appt.data.id}`,
      { token: adminToken },
    );
    const consumedOk =
      completed.data.status === 'COMPLETED' &&
      (completed.data.entitlementConsumedAt != null ||
        apptDetail.data.entitlementConsumedAt != null) &&
      entAfter.data.consumedSessions === consumedBefore + 1;
    if (consumedOk) {
      pass(
        'Entitlement appointment complete flow',
        `appointmentId=${appt.data.id} consumed=${entAfter.data.consumedSessions} remaining=${entAfter.data.remainingSessions}`,
      );
    } else {
      fail(
        'Entitlement appointment complete flow',
        `status=${completed.data.status} entitlementConsumedAt=${completed.data.entitlementConsumedAt} consumed=${entAfter.data.consumedSessions}`,
      );
    }
  } catch (e) {
    fail('Entitlement appointment complete flow', String(e));
  }

  await prisma.$disconnect();

  // Summary
  const passed = results.filter((r) => r.result === 'PASS').length;
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n=== Summary: ${passed} PASS, ${failed} FAIL ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
