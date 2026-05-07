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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
