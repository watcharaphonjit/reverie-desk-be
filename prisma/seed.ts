import 'dotenv/config';
import {
  RoleCode,
  SalesChannelCode,
  UserStatus,
  WarehouseType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { prisma } from '../src/lib/prisma';

const DEFAULT_ADMIN = {
  email: 'admin@reverie.local',
  password: 'Admin123!',
  fullName: 'System Admin',
} as const;

/**
 * Default permission grants. Role codes that don't appear here get no
 * reporting/dashboard/audit access. Branch-scoped roles (BRANCH_MANAGER,
 * etc.) still see only their own branch's data — that's enforced inside
 * each report service, not here.
 */
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
  {
    code: 'REPORT_VIEW',
    name: 'View Reports',
    description: 'Read-only access to /reports/* aggregation endpoints',
  },
  {
    code: 'DASHBOARD_VIEW',
    name: 'View Dashboards',
    description: 'Access /dashboard/* card endpoints',
  },
  {
    code: 'AUDIT_VIEW',
    name: 'View Audit Logs',
    description: 'Query the audit_logs trail',
  },
  {
    code: 'NOTIFICATION_VIEW',
    name: 'View Notifications',
    description: 'List and read own notifications',
  },
  {
    code: 'NOTIFICATION_MANAGE',
    name: 'Manage Notifications',
    description: 'Create / broadcast notifications outside automation',
  },
  {
    code: 'AUTOMATION_MANAGE',
    name: 'Manage Automation',
    description: 'List, run manually, and enable/disable automation rules',
  },
];

async function main() {
  const mainBranch = await prisma.branch.upsert({
    where: { code: 'HQ' },
    update: {},
    create: {
      code: 'HQ',
      name: 'Headquarters',
    },
  });

  await prisma.role.createMany({
    data: Object.values(RoleCode).map((code) => ({
      code,
      name: code,
    })),
    skipDuplicates: true,
  });

  await seedPermissions();

  await prisma.salesChannel.createMany({
    data: Object.values(SalesChannelCode).map((code) => ({
      code,
      name: code,
    })),
    skipDuplicates: true,
  });

  await prisma.warehouse.createMany({
    data: [
      {
        code: 'CENTRAL',
        name: 'Central Hub',
        type: WarehouseType.CENTRAL_HUB,
      },
      {
        code: 'HQ-WH',
        name: 'HQ Warehouse',
        type: WarehouseType.BRANCH,
        branchId: mainBranch.id,
      },
    ],
    skipDuplicates: true,
  });

  await seedDefaultAdmin(mainBranch.id);

  console.log('✅ Seed completed');
}

async function seedDefaultAdmin(branchId: string): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { email: DEFAULT_ADMIN.email },
    select: { id: true },
  });
  if (existing) {
    console.log(`ℹ️ Default admin already exists (${DEFAULT_ADMIN.email})`);
    return;
  }

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
      userRoles: {
        create: { roleId: adminRole.id, branchId },
      },
    },
  });

  console.log(`✅ Default admin created (${DEFAULT_ADMIN.email})`);
}

async function seedPermissions(): Promise<void> {
  await prisma.permission.createMany({
    data: PERMISSION_DEFINITIONS,
    skipDuplicates: true,
  });

  const permissions = await prisma.permission.findMany({
    select: { id: true, code: true },
  });
  const permIdByCode = new Map(permissions.map((p) => [p.code, p.id]));

  const roles = await prisma.role.findMany({
    select: { id: true, code: true },
  });
  const grantRows: Array<{ roleId: string; permissionId: string }> = [];
  for (const role of roles) {
    for (const code of ROLE_PERMISSION_GRANTS[role.code] ?? []) {
      const permissionId = permIdByCode.get(code);
      if (permissionId) grantRows.push({ roleId: role.id, permissionId });
    }
  }
  if (grantRows.length > 0) {
    await prisma.rolePermission.createMany({
      data: grantRows,
      skipDuplicates: true,
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
