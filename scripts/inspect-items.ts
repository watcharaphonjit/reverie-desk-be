import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const p = new PrismaClient({ adapter });

(async () => {
  const units = await p.unit.findMany();
  console.log('UNITS:', JSON.stringify(units, null, 2));
  await p.$disconnect();
})();
