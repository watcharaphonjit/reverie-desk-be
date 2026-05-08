/**
 * Dev seed: minimal + a handful of demo branches and users so a fresh
 * developer can poke around the UI without manually creating fixtures.
 *
 * Idempotent. Safe to re-run. Adds:
 *   - 2 extra branches (BR-A, BR-B)
 *   - 1 BRANCH_MANAGER, 1 DOCTOR, 1 TELESALES per branch
 *
 * Run with `npm run seed:dev`.
 */
import 'dotenv/config';
import { RoleCode, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { prisma } from '../../src/lib/prisma';
import { runMinimalSeed } from './shared';

const DEMO_BRANCHES = [
  { code: 'BR-A', name: 'Branch Alpha' },
  { code: 'BR-B', name: 'Branch Beta' },
];

interface DemoUser {
  email: string;
  fullName: string;
  password: string;
  role: RoleCode;
}

function makeDemoUsers(branchCode: string): DemoUser[] {
  const slug = branchCode.toLowerCase();
  return [
    { email: `manager.${slug}@reverie.local`, fullName: `Manager ${branchCode}`, password: 'Password123!', role: RoleCode.BRANCH_MANAGER },
    { email: `doctor.${slug}@reverie.local`, fullName: `Doctor ${branchCode}`, password: 'Password123!', role: RoleCode.DOCTOR },
    { email: `tele.${slug}@reverie.local`, fullName: `Telesales ${branchCode}`, password: 'Password123!', role: RoleCode.TELESALES },
  ];
}

async function main(): Promise<void> {
  await runMinimalSeed();

  for (const def of DEMO_BRANCHES) {
    const branch = await prisma.branch.upsert({
      where: { code: def.code },
      update: { name: def.name },
      create: def,
    });
    const users = makeDemoUsers(def.code);
    for (const u of users) {
      const role = await prisma.role.findUnique({ where: { code: u.role } });
      if (!role) continue;
      await prisma.user.upsert({
        where: { email: u.email },
        update: { branchId: branch.id, status: UserStatus.ACTIVE },
        create: {
          email: u.email,
          fullName: u.fullName,
          passwordHash: await bcrypt.hash(u.password, 12),
          branchId: branch.id,
          status: UserStatus.ACTIVE,
          userRoles: { create: { roleId: role.id, branchId: branch.id } },
        },
      });
    }
  }
  await prisma.$disconnect();
  console.log('✅ Dev seed completed (default admin + demo branches/users)');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
