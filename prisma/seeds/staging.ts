/**
 * Staging seed: dev profile + a small set of demo customers so QA / UAT
 * have something to click through.
 *
 * Idempotent. Run with `npm run seed:staging`.
 *
 * Stock items are intentionally NOT seeded here — they require unit and
 * type metadata that lives downstream. The clinical-flow smoke creates
 * its own; new operators can use the inventory UI.
 */
import 'dotenv/config';
import { prisma } from '../../src/lib/prisma';
import { runMinimalSeed } from './shared';

const DEMO_CUSTOMERS = [
  { code: 'CUS-DEMO-1', fullName: 'Alex Demo', phone: '+10000000001' },
  { code: 'CUS-DEMO-2', fullName: 'Briar Demo', phone: '+10000000002' },
  { code: 'CUS-DEMO-3', fullName: 'Casey Demo', phone: '+10000000003' },
];

async function main(): Promise<void> {
  await runMinimalSeed();

  const branch = await prisma.branch.findUnique({ where: { code: 'HQ' } });
  if (!branch) throw new Error('HQ branch missing');

  for (const c of DEMO_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { code: c.code },
      update: { fullName: c.fullName },
      create: {
        code: c.code,
        fullName: c.fullName,
        phone: c.phone,
        currentBranchId: branch.id,
      },
    });
  }

  await prisma.$disconnect();
  console.log(`✅ Staging seed completed (${DEMO_CUSTOMERS.length} demo customers)`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
