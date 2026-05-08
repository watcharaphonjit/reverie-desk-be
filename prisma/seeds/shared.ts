/**
 * Shared building blocks for the seed profiles. Profiles compose these
 * functions so the dev / staging / minimal entry points stay focused on
 * "what extra data does this environment need?" rather than re-stating
 * the catalog setup.
 *
 * Everything here is idempotent — re-running a profile against a populated
 * DB updates rather than duplicates (skipDuplicates / upsert / findFirst).
 */
import {
  CommissionType,
  CommissionValueType,
  Prisma,
  RoleCode,
  SalesChannelCode,
  ServiceGroupCode,
  UserStatus,
  WarehouseType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { prisma } from '../../src/lib/prisma';

const DEFAULT_ADMIN = {
  email: 'admin@reverie.local',
  password: 'Admin123!',
  fullName: 'System Admin',
} as const;

const ROLE_PERMISSION_GRANTS: Record<RoleCode, string[]> = {
  ADMIN: [
    'REPORT_VIEW',
    'DASHBOARD_VIEW',
    'AUDIT_VIEW',
    'NOTIFICATION_VIEW',
    'NOTIFICATION_MANAGE',
    'AUTOMATION_MANAGE',
  ],
  SUPER_BRANCH_MANAGER: [
    'REPORT_VIEW',
    'DASHBOARD_VIEW',
    'AUDIT_VIEW',
    'NOTIFICATION_VIEW',
    'NOTIFICATION_MANAGE',
    'AUTOMATION_MANAGE',
  ],
  BRANCH_MANAGER: [
    'REPORT_VIEW',
    'DASHBOARD_VIEW',
    'AUDIT_VIEW',
    'NOTIFICATION_VIEW',
    'NOTIFICATION_MANAGE',
  ],
  CS: ['REPORT_VIEW', 'DASHBOARD_VIEW', 'NOTIFICATION_VIEW'],
  TELESALES: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW'],
  DOCTOR: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW'],
  EMPLOYEE: ['NOTIFICATION_VIEW'],
  CENTRAL_STOCK_HUB: ['REPORT_VIEW', 'NOTIFICATION_VIEW'],
};

const PERMISSION_DEFINITIONS: Array<{
  code: string;
  name: string;
  description: string;
}> = [
  { code: 'REPORT_VIEW', name: 'View Reports', description: 'Read-only access to /reports/*' },
  { code: 'DASHBOARD_VIEW', name: 'View Dashboards', description: 'Access /dashboard/* endpoints' },
  { code: 'AUDIT_VIEW', name: 'View Audit Logs', description: 'Query the audit_logs trail' },
  { code: 'NOTIFICATION_VIEW', name: 'View Notifications', description: 'Read own notifications' },
  { code: 'NOTIFICATION_MANAGE', name: 'Manage Notifications', description: 'Broadcast notifications' },
  { code: 'AUTOMATION_MANAGE', name: 'Manage Automation', description: 'Run/toggle rules' },
];

export async function seedRolesPermissions(): Promise<void> {
  await prisma.role.createMany({
    data: Object.values(RoleCode).map((code) => ({ code, name: code })),
    skipDuplicates: true,
  });
  await prisma.permission.createMany({
    data: PERMISSION_DEFINITIONS,
    skipDuplicates: true,
  });
  const [permissions, roles] = await Promise.all([
    prisma.permission.findMany({ select: { id: true, code: true } }),
    prisma.role.findMany({ select: { id: true, code: true } }),
  ]);
  const permIdByCode = new Map(permissions.map((p) => [p.code, p.id]));
  const grants: Array<{ roleId: string; permissionId: string }> = [];
  for (const role of roles) {
    for (const code of ROLE_PERMISSION_GRANTS[role.code] ?? []) {
      const permissionId = permIdByCode.get(code);
      if (permissionId) grants.push({ roleId: role.id, permissionId });
    }
  }
  if (grants.length > 0) {
    await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
  }
}

export async function seedSalesChannels(): Promise<void> {
  await prisma.salesChannel.createMany({
    data: Object.values(SalesChannelCode).map((code) => ({ code, name: code })),
    skipDuplicates: true,
  });
}

export async function seedHQBranchAndWarehouse(): Promise<{ branchId: string }> {
  const branch = await prisma.branch.upsert({
    where: { code: 'HQ' },
    update: {},
    create: { code: 'HQ', name: 'Headquarters' },
  });
  await prisma.warehouse.createMany({
    data: [
      { code: 'CENTRAL', name: 'Central Hub', type: WarehouseType.CENTRAL_HUB },
      {
        code: 'HQ-WH',
        name: 'HQ Warehouse',
        type: WarehouseType.BRANCH,
        branchId: branch.id,
      },
    ],
    skipDuplicates: true,
  });
  return { branchId: branch.id };
}

export async function seedDefaultAdmin(branchId: string): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { email: DEFAULT_ADMIN.email },
    select: { id: true },
  });
  if (existing) return;

  const adminRole = await prisma.role.findUnique({
    where: { code: RoleCode.ADMIN },
    select: { id: true },
  });
  if (!adminRole) throw new Error('ADMIN role missing — run role seed first');

  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN.password, 12);
  await prisma.user.create({
    data: {
      email: DEFAULT_ADMIN.email,
      fullName: DEFAULT_ADMIN.fullName,
      passwordHash,
      branchId,
      status: UserStatus.ACTIVE,
      userRoles: { create: { roleId: adminRole.id, branchId } },
    },
  });
}

/**
 * Default tier ladders for each commission group. Numbers below are the
 * canonical baseline pulled from the original spec — they represent the
 * "rate ≥ 1 means fixed THB; rate < 1 means percentage" convention.
 *
 * Operators are expected to override these via the bulk-upsert API
 * after rolling out a new branch. We seed them so a freshly-cloned
 * environment behaves end-to-end without requiring manual setup.
 */
type TierSeed = {
  minimum: number;
  rate: number;
  type: CommissionValueType;
};

const DEFAULT_COMMISSION_TIERS: Record<ServiceGroupCode, TierSeed[]> = {
  RATE_SKIN: [
    { minimum: 1, rate: 30, type: CommissionValueType.FIXED },
    { minimum: 2001, rate: 50, type: CommissionValueType.FIXED },
    { minimum: 5000, rate: 0.03, type: CommissionValueType.PERCENTAGE },
    { minimum: 10000, rate: 0.05, type: CommissionValueType.PERCENTAGE },
    { minimum: 20000, rate: 0.07, type: CommissionValueType.PERCENTAGE },
  ],
  RATE_HAIR: [
    { minimum: 1, rate: 50, type: CommissionValueType.FIXED },
    { minimum: 5000, rate: 0.04, type: CommissionValueType.PERCENTAGE },
    { minimum: 15000, rate: 0.06, type: CommissionValueType.PERCENTAGE },
  ],
  RATE_SURGERY: [
    { minimum: 1, rate: 0.05, type: CommissionValueType.PERCENTAGE },
    { minimum: 50000, rate: 0.08, type: CommissionValueType.PERCENTAGE },
    { minimum: 150000, rate: 0.1, type: CommissionValueType.PERCENTAGE },
  ],
  RATE_TRANSPLANT: [
    { minimum: 1, rate: 0.05, type: CommissionValueType.PERCENTAGE },
    { minimum: 80000, rate: 0.07, type: CommissionValueType.PERCENTAGE },
    { minimum: 200000, rate: 0.1, type: CommissionValueType.PERCENTAGE },
  ],
  RATE_MEDICINE: [
    { minimum: 1, rate: 20, type: CommissionValueType.FIXED },
    { minimum: 1000, rate: 0.02, type: CommissionValueType.PERCENTAGE },
    { minimum: 5000, rate: 0.04, type: CommissionValueType.PERCENTAGE },
  ],
  RATE_SCULPTRA: [
    { minimum: 1, rate: 100, type: CommissionValueType.FIXED },
    { minimum: 10000, rate: 0.05, type: CommissionValueType.PERCENTAGE },
    { minimum: 30000, rate: 0.08, type: CommissionValueType.PERCENTAGE },
  ],
};

/**
 * Idempotent commission-rule seed. For each (branch, group) pair:
 *   - if any active SALES_COMMISSION tier already exists, do nothing.
 *     This protects environments where ops have already tuned the
 *     ladder via bulk-upsert.
 *   - otherwise insert the default tiers.
 */
export async function seedDefaultCommissionRules(branchId: string): Promise<void> {
  for (const group of Object.values(ServiceGroupCode)) {
    const existing = await prisma.commissionRule.findFirst({
      where: {
        branchId,
        serviceGroupCode: group,
        commissionType: CommissionType.SALES_COMMISSION,
        isActive: true,
      },
      select: { id: true },
    });
    if (existing) continue;

    const tiers = DEFAULT_COMMISSION_TIERS[group];
    for (const tier of tiers) {
      await prisma.commissionRule.create({
        data: {
          branchId,
          serviceGroupCode: group,
          commissionType: CommissionType.SALES_COMMISSION,
          valueType: tier.type,
          value: new Prisma.Decimal(tier.rate),
          minAmount: new Prisma.Decimal(tier.minimum),
          isActive: true,
        },
      });
    }
  }
}

/**
 * Smallest possible footprint: roles, permissions, sales channels, HQ
 * branch + warehouse, default admin, default commission ladders for HQ.
 * Useful for CI and a fresh dev environment.
 */
export async function runMinimalSeed(): Promise<void> {
  const { branchId } = await seedHQBranchAndWarehouse();
  await seedRolesPermissions();
  await seedSalesChannels();
  await seedDefaultAdmin(branchId);
  await seedDefaultCommissionRules(branchId);
  await prisma.$disconnect();
}
