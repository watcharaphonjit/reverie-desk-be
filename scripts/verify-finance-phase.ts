import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CommissionStatus,
  CommissionType,
  PrismaClient,
  SalesOrderStatus,
  ServiceGroupCode,
  WalletType,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001/api/v1';
const REPORT_PATH =
  process.env.FINANCE_REPORT_PATH ??
  'c:\\Users\\Ongaj\\Desktop\\projects\\clinic-sync\\docs\\verification\\finance-phase-verification-local.md';

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success: false;
  error: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

type ApiResponse<T> = ApiSuccess<T> | ApiError;

interface CallResult<T> {
  status: number;
  body: ApiResponse<T>;
}

interface ScenarioRecord {
  title: string;
  pass: boolean;
  summary: string;
  details: string[];
}

interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

interface PaymentResponse {
  id: string;
  amount: string | number;
  paymentType: string;
  paidAt: string | null;
  salesOrder: {
    id: string;
    orderNo: string;
    status: SalesOrderStatus;
    depositSatisfiedAt: string | null;
  };
}

interface CommissionResponse {
  id: string;
  salesOrderId: string;
  recipientUserId: string;
  type: CommissionType;
  status: CommissionStatus;
  amount: string | number;
  eligibleAt: string | null;
  lockedAt: string | null;
  paidAt: string | null;
  salesOrder?: { id: string; orderNo: string; branchId: string; status: string };
  recipientUser?: { id: string; fullName: string; email: string };
  snapshot?: {
    id: string;
    serviceGroupCode: ServiceGroupCode | null;
    groupSubtotal: string | null;
    ruleValueType: 'FIXED' | 'PERCENTAGE';
    ruleValue: string | number;
    computedAmount: string | number;
    snapshotBranchName: string | null;
    snapshotServiceName: string | null;
  };
}

interface BatchActionResult {
  requestedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  results: Array<{
    id: string;
    success: boolean;
    error?: string;
    commission?: CommissionResponse;
  }>;
}

interface WalletRow {
  id: string;
  customerId: string;
  type: WalletType;
  balance: string | number;
  currency?: string;
}

interface WalletMutationResult {
  wallet: WalletRow;
  transaction: {
    id: string;
    type: string;
    amount: string | number;
    balanceBefore: string | number;
    balanceAfter: string | number;
    referenceType: string | null;
    referenceId: string | null;
  };
}

interface WalletTransferResult {
  out: WalletMutationResult;
  in: WalletMutationResult;
}

interface WalletHistoryRow {
  id: string;
  type: string;
  amount: string | number;
  balanceBefore: string | number;
  balanceAfter: string | number;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

interface SalesReport {
  summary: {
    totalOrders: number;
    netSales: string | number;
  };
}

interface PaymentsReport {
  summary: {
    successAmount: string | number;
    netCollected: string | number;
    totalPayments: number;
  };
}

interface WalletsReport {
  summary: {
    totalBalance: string | number;
    totalCredit: string | number;
    totalDebit: string | number;
    net: string | number;
    activeWallets: number;
  };
}

interface CommissionsReport {
  summary: {
    totalCommissions: number;
    totalAmount: string | number;
    PAID: { count: number; amount: string | number };
  };
}

interface ReportSnapshot {
  recognizedRevenue: number;
  recognizedOrders: number;
  payments: {
    successAmount: number;
    netCollected: number;
    totalPayments: number;
  };
  wallets: {
    totalBalance: number;
    totalCredit: number;
    totalDebit: number;
    net: number;
    activeWallets: number;
  };
  commissions: {
    totalCommissions: number;
    totalAmount: number;
    paidCount: number;
    paidAmount: number;
  };
}

async function call<T>(
  method: string,
  pathName: string,
  body?: unknown,
  token?: string,
): Promise<CallResult<T>> {
  const res = await fetch(`${BASE_URL}${pathName}`, {
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
      error: { code: 'PARSE', message: text || 'no response body' },
    };
  }

  return { status: res.status, body: parsed };
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function getSuccessData<T>(result: CallResult<T>, message: string): T {
  expect(result.body.success, message);
  return (result.body as ApiSuccess<T>).data;
}

function num(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return Number(String(value));
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextDate(dateOnly: string): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dbLabel(url: string | undefined): string {
  if (!url) return 'DATABASE_URL not set';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//***:***@${parsed.host}${parsed.pathname}`;
  } catch {
    return 'DATABASE_URL present (unparseable)';
  }
}

async function fetchReportSnapshot(
  token: string,
  startDate: string,
  endDateExclusive: string,
): Promise<ReportSnapshot> {
  const [paidSales, completedSales, payments, wallets, commissions] =
    await Promise.all([
      call<SalesReport>(
        'GET',
        `/reports/sales?status=PAID&groupBy=day&startDate=${startDate}&endDate=${endDateExclusive}`,
        undefined,
        token,
      ),
      call<SalesReport>(
        'GET',
        `/reports/sales?status=COMPLETED&groupBy=day&startDate=${startDate}&endDate=${endDateExclusive}`,
        undefined,
        token,
      ),
      call<PaymentsReport>(
        'GET',
        `/reports/payments?startDate=${startDate}&endDate=${endDateExclusive}`,
        undefined,
        token,
      ),
      call<WalletsReport>(
        'GET',
        `/reports/wallets?startDate=${startDate}&endDate=${endDateExclusive}`,
        undefined,
        token,
      ),
      call<CommissionsReport>(
        'GET',
        `/reports/commissions?groupBy=branch&startDate=${startDate}&endDate=${endDateExclusive}`,
        undefined,
        token,
      ),
    ]);

  const paidSalesData = getSuccessData(paidSales, 'paid sales report failed');
  const completedSalesData = getSuccessData(
    completedSales,
    'completed sales report failed',
  );
  const paymentsData = getSuccessData(payments, 'payments report failed');
  const walletsData = getSuccessData(wallets, 'wallets report failed');
  const commissionsData = getSuccessData(
    commissions,
    'commissions report failed',
  );

  return {
    recognizedRevenue:
      num(paidSalesData.summary.netSales) +
      num(completedSalesData.summary.netSales),
    recognizedOrders:
      paidSalesData.summary.totalOrders + completedSalesData.summary.totalOrders,
    payments: {
      successAmount: num(paymentsData.summary.successAmount),
      netCollected: num(paymentsData.summary.netCollected),
      totalPayments: paymentsData.summary.totalPayments,
    },
    wallets: {
      totalBalance: num(walletsData.summary.totalBalance),
      totalCredit: num(walletsData.summary.totalCredit),
      totalDebit: num(walletsData.summary.totalDebit),
      net: num(walletsData.summary.net),
      activeWallets: walletsData.summary.activeWallets,
    },
    commissions: {
      totalCommissions: commissionsData.summary.totalCommissions,
      totalAmount: num(commissionsData.summary.totalAmount),
      paidCount: commissionsData.summary.PAID.count,
      paidAmount: num(commissionsData.summary.PAID.amount),
    },
  };
}

function diffReports(after: ReportSnapshot, before: ReportSnapshot) {
  return {
    recognizedRevenue: after.recognizedRevenue - before.recognizedRevenue,
    recognizedOrders: after.recognizedOrders - before.recognizedOrders,
    payments: {
      successAmount: after.payments.successAmount - before.payments.successAmount,
      netCollected: after.payments.netCollected - before.payments.netCollected,
      totalPayments: after.payments.totalPayments - before.payments.totalPayments,
    },
    wallets: {
      totalBalance: after.wallets.totalBalance - before.wallets.totalBalance,
      totalCredit: after.wallets.totalCredit - before.wallets.totalCredit,
      totalDebit: after.wallets.totalDebit - before.wallets.totalDebit,
      net: after.wallets.net - before.wallets.net,
      activeWallets: after.wallets.activeWallets - before.wallets.activeWallets,
    },
    commissions: {
      totalCommissions:
        after.commissions.totalCommissions - before.commissions.totalCommissions,
      totalAmount: after.commissions.totalAmount - before.commissions.totalAmount,
      paidCount: after.commissions.paidCount - before.commissions.paidCount,
      paidAmount: after.commissions.paidAmount - before.commissions.paidAmount,
    },
  };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-7);
  const today = todayDateOnly();
  const tomorrow = nextDate(today);
  const scenarios: ScenarioRecord[] = [];

  try {
    const health = await call<{ status: string; db: string }>('GET', '/health');
    expect(health.status === 200, 'health endpoint must return 200');

    const login = await call<{ accessToken: string }>('POST', '/auth/login', {
      email: 'admin@reverie.local',
      password: 'Admin123!',
    });
    const token = getSuccessData(login, 'admin login failed').accessToken;

    const branch = await prisma.branch.findFirst({ where: { status: 'ACTIVE' } });
    expect(!!branch, 'Need an ACTIVE branch');
    const adminUser = await prisma.user.findUnique({
      where: { email: 'admin@reverie.local' },
    });
    expect(!!adminUser, 'Need admin user');

    let leadOwner = await prisma.user.findFirst({
      where: { email: `finance-lead-owner-${stamp}@reverie.local` },
    });
    if (!leadOwner) {
      leadOwner = await prisma.user.create({
        data: {
          email: `finance-lead-owner-${stamp}@reverie.local`,
          fullName: `Finance Lead Owner ${stamp}`,
          passwordHash: 'unused',
          branchId: branch!.id,
          status: 'ACTIVE',
        },
      });
    }

    const customerA = await prisma.customer.create({
      data: {
        code: `FIN-CUST-A-${stamp}`,
        fullName: `Finance Customer A ${stamp}`,
        phone: `+6681${stamp}`,
        currentBranchId: branch!.id,
      },
    });
    const customerB = await prisma.customer.create({
      data: {
        code: `FIN-CUST-B-${stamp}`,
        fullName: `Finance Customer B ${stamp}`,
        phone: `+6682${stamp}`,
        currentBranchId: branch!.id,
      },
    });

    const lead = await prisma.lead.create({
      data: {
        code: `FIN-LEAD-${stamp}`,
        branchId: branch!.id,
        customerId: customerA.id,
        name: customerA.fullName,
        phone: customerA.phone,
        currentOwnerUserId: leadOwner.id,
        createdByUserId: adminUser!.id,
      },
    });

    const skinService = await prisma.service.create({
      data: {
        code: `FIN-SKIN-${stamp}`,
        name: `Finance Skin ${stamp}`,
        commissionGroupCode: ServiceGroupCode.RATE_SKIN,
        basePrice: 1000,
      },
    });
    const hairService = await prisma.service.create({
      data: {
        code: `FIN-HAIR-${stamp}`,
        name: `Finance Hair ${stamp}`,
        commissionGroupCode: ServiceGroupCode.RATE_HAIR,
        basePrice: 1000,
      },
    });

    const order = await prisma.salesOrder.create({
      data: {
        orderNo: `FIN-SO-${stamp}`,
        branchId: branch!.id,
        customerId: customerA.id,
        leadId: lead.id,
        createdByUserId: adminUser!.id,
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

    await prisma.appointment.create({
      data: {
        appointmentNo: `FIN-APT-${stamp}`,
        branchId: branch!.id,
        salesOrderId: order.id,
        customerId: customerA.id,
        serviceId: skinService.id,
        createdByUserId: adminUser!.id,
        scheduledAt: new Date(Date.now() + 86400000),
        status: 'BOOKED',
      },
    });

    const beforeReports = await fetchReportSnapshot(token, today, tomorrow);

    // Seed both commission ladders.
    getSuccessData(
      await call<{ bundlesUpdated: number; tiersWritten: number }>(
        'POST',
        '/commission-rules/bulk-upsert',
        {
          bundles: [
            {
              branchId: branch!.id,
              serviceGroupCode: 'RATE_SKIN',
              commissionType: 'SALES_COMMISSION',
              tiers: [
                { minimum: 1, rate: 30, type: 'FIXED' },
                { minimum: 2001, rate: 50, type: 'FIXED' },
              ],
            },
            {
              branchId: branch!.id,
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
      'sales commission rules upsert failed',
    );
    getSuccessData(
      await call<{ bundlesUpdated: number; tiersWritten: number }>(
        'POST',
        '/commission-rules/bulk-upsert',
        {
          bundles: [
            {
              branchId: branch!.id,
              serviceGroupCode: 'RATE_SKIN',
              commissionType: 'LEAD_REWARD',
              tiers: [{ minimum: 1, rate: 30, type: 'FIXED' }],
            },
            {
              branchId: branch!.id,
              serviceGroupCode: 'RATE_HAIR',
              commissionType: 'LEAD_REWARD',
              tiers: [{ minimum: 1, rate: 100, type: 'FIXED' }],
            },
          ],
        },
        token,
      ),
      'lead reward rules upsert failed',
    );

    let generatedCommissions: CommissionResponse[] = [];
    let depositPaymentId = '';
    let depositWalletId = '';
    let finalWalletBalance = 0;

    try {
      const deposit = getSuccessData(
        await call<PaymentResponse>(
          'POST',
          '/payments',
          {
            salesOrderId: order.id,
            amount: 4000,
            paymentMethod: 'CASH',
            paymentType: 'DEPOSIT',
            note: `Finance verification deposit ${stamp}`,
          },
          token,
        ),
        'deposit payment failed',
      );
      depositPaymentId = deposit.id;

      const commissionList = getSuccessData(
        await call<Paginated<CommissionResponse>>(
          'GET',
          `/commissions?branchId=${branch!.id}&salesOrderId=${order.id}&periodField=CREATED_AT&from=${today}&to=${today}`,
          undefined,
          token,
        ),
        'commission list failed after deposit payment',
      );
      generatedCommissions = commissionList.data;
      expect(generatedCommissions.length === 4, 'Expected 4 commission rows');

      const rewardRows = getSuccessData(
        await call<Paginated<CommissionResponse>>(
          'GET',
          `/commissions?recipientUserId=${leadOwner.id}&salesOrderId=${order.id}&periodField=CREATED_AT&from=${today}&to=${today}`,
          undefined,
          token,
        ),
        'recipient-filtered commission list failed',
      );
      expect(
        rewardRows.data.length === 2,
        'recipient filter should return 2 LEAD_REWARD rows',
      );

      const depositWallets = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'wallet list failed after deposit payment',
      );
      const depositWallet = depositWallets.find(
        (wallet) => wallet.type === WalletType.DEPOSIT,
      );
      expect(!!depositWallet, 'Deposit wallet should exist after deposit payment');
      depositWalletId = depositWallet!.id;

      scenarios.push({
        title: 'Scenario 1 - Commission generation',
        pass: true,
        summary: 'Deposit payment generated the expected 4 commission rows.',
        details: [
          `Created sales order: ${order.orderNo} (${order.id})`,
          `Deposit payment ID: ${deposit.id}`,
          `Branch filter + period filter returned ${commissionList.data.length} row(s)`,
          `Lead-owner recipient filter returned ${rewardRows.data.length} row(s)`,
          `Commission IDs: ${generatedCommissions.map((item) => item.id).join(', ')}`,
          `Commission amounts: ${generatedCommissions.map((item) => `${item.type}/${item.snapshot?.serviceGroupCode ?? 'NONE'}=${num(item.amount)}`).join(', ')}`,
        ],
      });
    } catch (error) {
      scenarios.push({
        title: 'Scenario 1 - Commission generation',
        pass: false,
        summary: 'Commission generation failed.',
        details: [shortError(error)],
      });
    }

    try {
      const beforeStatuses = generatedCommissions.map((item) => ({
        id: item.id,
        status: item.status,
      }));
      const lockResult = getSuccessData(
        await call<BatchActionResult>(
          'POST',
          '/commissions/lock-batch',
          {
            ids: generatedCommissions.map((item) => item.id),
            note: `Finance verification lock ${stamp}`,
          },
          token,
        ),
        'commission lock batch failed',
      );
      expect(lockResult.failedCount === 0, 'All commissions should lock cleanly');

      const afterList = getSuccessData(
        await call<Paginated<CommissionResponse>>(
          'GET',
          `/commissions?salesOrderId=${order.id}&periodField=CREATED_AT&from=${today}&to=${today}`,
          undefined,
          token,
        ),
        'commission list failed after lock batch',
      );
      expect(
        afterList.data.every((item) => item.status === CommissionStatus.LOCKED),
        'All commissions should now be LOCKED',
      );

      scenarios.push({
        title: 'Scenario 2 - Commission lock',
        pass: true,
        summary: 'Batch lock transitioned every generated commission from ELIGIBLE to LOCKED.',
        details: [
          `Before: ${beforeStatuses.map((item) => `${item.id}:${item.status}`).join(', ')}`,
          `After: ${afterList.data.map((item) => `${item.id}:${item.status}`).join(', ')}`,
          `Batch result: requested=${lockResult.requestedCount}, succeeded=${lockResult.succeededCount}, failed=${lockResult.failedCount}`,
        ],
      });
      generatedCommissions = afterList.data;
    } catch (error) {
      scenarios.push({
        title: 'Scenario 2 - Commission lock',
        pass: false,
        summary: 'Commission lock failed.',
        details: [shortError(error)],
      });
    }

    try {
      const beforeStatuses = generatedCommissions.map((item) => ({
        id: item.id,
        status: item.status,
      }));
      const payResult = getSuccessData(
        await call<BatchActionResult>(
          'POST',
          '/commissions/pay-batch',
          {
            ids: generatedCommissions.map((item) => item.id),
            note: `Finance verification payout ${stamp}`,
          },
          token,
        ),
        'commission pay batch failed',
      );
      expect(payResult.failedCount === 0, 'All commissions should pay cleanly');

      const afterList = getSuccessData(
        await call<Paginated<CommissionResponse>>(
          'GET',
          `/commissions?salesOrderId=${order.id}&periodField=CREATED_AT&from=${today}&to=${today}`,
          undefined,
          token,
        ),
        'commission list failed after payout',
      );
      expect(
        afterList.data.every((item) => item.status === CommissionStatus.PAID),
        'All commissions should now be PAID',
      );

      scenarios.push({
        title: 'Scenario 3 - Commission payout',
        pass: true,
        summary: 'Batch payout transitioned every locked commission to PAID.',
        details: [
          `Before: ${beforeStatuses.map((item) => `${item.id}:${item.status}`).join(', ')}`,
          `After: ${afterList.data.map((item) => `${item.id}:${item.status}@${item.paidAt ?? 'no-paidAt'}`).join(', ')}`,
          `Batch result: requested=${payResult.requestedCount}, succeeded=${payResult.succeededCount}, failed=${payResult.failedCount}`,
        ],
      });
      generatedCommissions = afterList.data;
    } catch (error) {
      scenarios.push({
        title: 'Scenario 3 - Commission payout',
        pass: false,
        summary: 'Commission payout failed.',
        details: [shortError(error)],
      });
    }

    try {
      const walletsBefore = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'wallet list before manual credit failed',
      );
      const walletBefore = walletsBefore.find((wallet) => wallet.type === WalletType.DEPOSIT);
      expect(!!walletBefore, 'Deposit wallet should exist before manual credit');

      const credit = getSuccessData(
        await call<WalletMutationResult>(
          'POST',
          '/wallet/credit',
          {
            customerId: customerA.id,
            walletType: 'DEPOSIT',
            amount: 250,
            branchId: branch!.id,
            note: `Finance verification credit ${stamp}`,
          },
          token,
        ),
        'wallet credit failed',
      );
      const history = getSuccessData(
        await call<Paginated<WalletHistoryRow>>(
          'GET',
          `/wallet/history?customerId=${customerA.id}&walletType=DEPOSIT&from=${today}&to=${today}`,
          undefined,
          token,
        ),
        'wallet history query failed after credit',
      );
      expect(
        history.data.some((entry) => entry.id === credit.transaction.id),
        'wallet history should include the manual credit transaction',
      );

      scenarios.push({
        title: 'Scenario 4 - Wallet credit',
        pass: true,
        summary: 'Manual wallet credit succeeded and appeared in wallet history.',
        details: [
          `Wallet ID: ${credit.wallet.id}`,
          `Transaction ID: ${credit.transaction.id}`,
          `Before balance: ${num(walletBefore!.balance)}`,
          `After balance: ${num(credit.wallet.balance)}`,
        ],
      });
      finalWalletBalance = num(credit.wallet.balance);
      depositWalletId = credit.wallet.id;
    } catch (error) {
      scenarios.push({
        title: 'Scenario 4 - Wallet credit',
        pass: false,
        summary: 'Wallet credit failed.',
        details: [shortError(error)],
      });
    }

    try {
      const before = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'wallet list before debit failed',
      ).find((wallet) => wallet.type === WalletType.DEPOSIT);
      expect(!!before, 'Deposit wallet must exist before debit');

      const debit = getSuccessData(
        await call<WalletMutationResult>(
          'POST',
          '/wallet/debit',
          {
            customerId: customerA.id,
            walletType: 'DEPOSIT',
            amount: 100,
            branchId: branch!.id,
            note: `Finance verification debit ${stamp}`,
          },
          token,
        ),
        'wallet debit failed',
      );
      const history = getSuccessData(
        await call<Paginated<WalletHistoryRow>>(
          'GET',
          `/wallet/history?customerId=${customerA.id}&walletType=DEPOSIT&from=${today}&to=${today}&type=DEBIT`,
          undefined,
          token,
        ),
        'wallet history query failed after debit',
      );
      expect(
        history.data.some((entry) => entry.id === debit.transaction.id),
        'wallet history should include the manual debit transaction',
      );

      scenarios.push({
        title: 'Scenario 5 - Wallet debit',
        pass: true,
        summary: 'Manual wallet debit succeeded and appeared in wallet history.',
        details: [
          `Wallet ID: ${debit.wallet.id}`,
          `Transaction ID: ${debit.transaction.id}`,
          `Before balance: ${num(before!.balance)}`,
          `After balance: ${num(debit.wallet.balance)}`,
        ],
      });
      finalWalletBalance = num(debit.wallet.balance);
    } catch (error) {
      scenarios.push({
        title: 'Scenario 5 - Wallet debit',
        pass: false,
        summary: 'Wallet debit failed.',
        details: [shortError(error)],
      });
    }

    try {
      const beforeSource = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'source wallet list before transfer failed',
      ).find((wallet) => wallet.type === WalletType.DEPOSIT);
      const beforeTarget = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerB.id}`,
          undefined,
          token,
        ),
        'target wallet list before transfer failed',
      ).find((wallet) => wallet.type === WalletType.DEPOSIT);

      const transfer = getSuccessData(
        await call<WalletTransferResult>(
          'POST',
          '/wallet/transfer',
          {
            fromCustomerId: customerA.id,
            toCustomerId: customerB.id,
            fromWalletType: 'DEPOSIT',
            toWalletType: 'DEPOSIT',
            amount: 50,
            branchId: branch!.id,
            note: `Finance verification transfer ${stamp}`,
          },
          token,
        ),
        'wallet transfer failed',
      );
      const targetHistory = getSuccessData(
        await call<Paginated<WalletHistoryRow>>(
          'GET',
          `/wallet/history?customerId=${customerB.id}&walletType=DEPOSIT&from=${today}&to=${today}&type=TRANSFER_IN`,
          undefined,
          token,
        ),
        'wallet history query failed after transfer',
      );
      expect(
        targetHistory.data.some((entry) => entry.id === transfer.in.transaction.id),
        'destination wallet history should include the transfer-in transaction',
      );

      scenarios.push({
        title: 'Scenario 6 - Wallet transfer',
        pass: true,
        summary: 'Wallet transfer succeeded and updated both source and destination balances.',
        details: [
          `Source before: ${num(beforeSource?.balance)}`,
          `Source after: ${num(transfer.out.wallet.balance)}`,
          `Destination before: ${num(beforeTarget?.balance)}`,
          `Destination after: ${num(transfer.in.wallet.balance)}`,
          `Transfer OUT transaction ID: ${transfer.out.transaction.id}`,
          `Transfer IN transaction ID: ${transfer.in.transaction.id}`,
        ],
      });
      finalWalletBalance = num(transfer.out.wallet.balance);
    } catch (error) {
      scenarios.push({
        title: 'Scenario 6 - Wallet transfer',
        pass: false,
        summary: 'Wallet transfer failed.',
        details: [shortError(error)],
      });
    }

    try {
      const before = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'wallet list before insufficient debit failed',
      ).find((wallet) => wallet.type === WalletType.DEPOSIT);
      const rejection = await call<WalletMutationResult>(
        'POST',
        '/wallet/debit',
        {
          customerId: customerA.id,
          walletType: 'DEPOSIT',
          amount: 999999,
          branchId: branch!.id,
          note: `Finance verification insufficient ${stamp}`,
        },
        token,
      );
      expect(rejection.status === 400, 'insufficient debit should return 400');

      const after = getSuccessData(
        await call<WalletRow[]>(
          'GET',
          `/wallet/customer/${customerA.id}`,
          undefined,
          token,
        ),
        'wallet list after insufficient debit failed',
      ).find((wallet) => wallet.type === WalletType.DEPOSIT);
      expect(
        num(before?.balance) === num(after?.balance),
        'wallet balance must remain unchanged after insufficient debit rejection',
      );

      scenarios.push({
        title: 'Scenario 7 - Insufficient wallet rejection',
        pass: true,
        summary: 'Insufficient debit request was rejected with HTTP 400 and left the balance unchanged.',
        details: [
          `Wallet ID: ${after?.id ?? depositWalletId}`,
          `Balance before: ${num(before?.balance)}`,
          `Balance after: ${num(after?.balance)}`,
          `Backend response: ${rejection.body.success ? 'unexpected success' : rejection.body.error.message ?? 'no message'}`,
        ],
      });
      finalWalletBalance = num(after?.balance);
    } catch (error) {
      scenarios.push({
        title: 'Scenario 7 - Insufficient wallet rejection',
        pass: false,
        summary: 'Insufficient wallet rejection failed.',
        details: [shortError(error)],
      });
    }

    try {
      const fullPayment = getSuccessData(
        await call<PaymentResponse>(
          'POST',
          '/payments',
          {
            salesOrderId: order.id,
            amount: 4000,
            paymentMethod: 'CASH',
            paymentType: 'FULL',
            note: `Finance verification full payment ${stamp}`,
          },
          token,
        ),
        'full payment failed',
      );
      expect(
        fullPayment.salesOrder.status === SalesOrderStatus.PAID,
        'full payment should push the sales order to PAID',
      );

      const afterReports = await fetchReportSnapshot(token, today, tomorrow);
      const delta = diffReports(afterReports, beforeReports);

      expect(delta.recognizedRevenue === 8000, 'recognized revenue delta should be 8000');
      expect(delta.recognizedOrders === 1, 'recognized order delta should be 1');
      expect(delta.payments.successAmount === 8000, 'payment success delta should be 8000');
      expect(delta.payments.netCollected === 8000, 'payment net-collected delta should be 8000');
      expect(delta.wallets.totalCredit === 4300, 'wallet credit delta should be 4300');
      expect(delta.wallets.totalDebit === 150, 'wallet debit delta should be 150');
      expect(delta.wallets.totalBalance === 4150, 'wallet balance delta should be 4150');
      expect(delta.wallets.net === 4150, 'wallet net delta should be 4150');
      expect(
        delta.commissions.totalCommissions === 4,
        'commission count delta should be 4',
      );
      expect(delta.commissions.totalAmount === 330, 'commission amount delta should be 330');
      expect(delta.commissions.paidCount === 4, 'paid commission count delta should be 4');
      expect(delta.commissions.paidAmount === 330, 'paid commission amount delta should be 330');

      scenarios.push({
        title: 'Scenario 8 - Finance dashboard aggregation integrity',
        pass: true,
        summary:
          'Report deltas matched the exact payment, wallet, commission, and recognized-revenue contributions from the verification fixtures.',
        details: [
          `Final sales order payment ID: ${fullPayment.id}`,
          `Final deposit-wallet balance: ${finalWalletBalance}`,
          `Recognized revenue delta: ${delta.recognizedRevenue}`,
          `Payments delta: success=${delta.payments.successAmount}, net=${delta.payments.netCollected}`,
          `Wallet delta: credit=${delta.wallets.totalCredit}, debit=${delta.wallets.totalDebit}, balance=${delta.wallets.totalBalance}, net=${delta.wallets.net}`,
          `Commission delta: count=${delta.commissions.totalCommissions}, amount=${delta.commissions.totalAmount}, paidCount=${delta.commissions.paidCount}, paidAmount=${delta.commissions.paidAmount}`,
        ],
      });
    } catch (error) {
      scenarios.push({
        title: 'Scenario 8 - Finance dashboard aggregation integrity',
        pass: false,
        summary: 'Finance report aggregation integrity check failed.',
        details: [shortError(error)],
      });
    }

    const overallPass = scenarios.every((scenario) => scenario.pass);
    const markdown = [
      '# Finance Phase Verification',
      '',
      '- Environment: LOCAL',
      `- Verification target: \`${BASE_URL}\``,
      `- Backend health: PASS (HTTP ${health.status})`,
      `- Local database used: \`${dbLabel(process.env.DATABASE_URL)}\``,
      '',
      ...scenarios.flatMap((scenario) => [
        `## ${scenario.title}`,
        '',
        `Status: **${scenario.pass ? 'PASS' : 'FAIL'}**`,
        '',
        scenario.summary,
        '',
        ...scenario.details.map((detail) => `- ${detail}`),
        '',
      ]),
      '## Backend Contract Gaps',
      '',
      overallPass
        ? '- None identified during local verification.'
        : '- See failed scenarios above for the remaining contract gap(s).',
      '',
      '## Phase 7 Blockers',
      '',
      overallPass
        ? '- None from Phase 6 local verification.'
        : '- Phase 7 is blocked until the failed Phase 6 scenario(s) above are resolved and re-run locally.',
      '',
    ].join('\n');

    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, markdown, 'utf8');

    console.log(markdown);
    if (!overallPass) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('FINANCE VERIFICATION FAILED:', error);
  process.exit(1);
});
