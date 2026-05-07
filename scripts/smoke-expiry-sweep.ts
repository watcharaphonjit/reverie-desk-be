/**
 * Smoke for the expiry-sweep job.
 *  - Seed a stock lot whose `expiresAt` is in the past.
 *  - Seed an opened container whose `expiryAt` is in the past.
 *  - POST /admin/expiry-sweep/run.
 *  - Verify lot.status=EXPIRED, lot.quantityOnHand=0, EXPIRE movement written.
 *  - Verify container.status=EXPIRED.
 *  - Verify a second run is a no-op (idempotent).
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConsumptionStrategy,
  PrismaClient,
  StockLotStatus,
  StockMovementType,
  OpenedContainerStatus,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

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
  return { status: res.status, body: (await res.json()) as ApiResponse<T> };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok   ${msg}`);
}

const decToNum = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v));
};

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });
  const stamp = Date.now().toString().slice(-6);

  const stockItem = await prisma.stockItem.findFirst({ where: { isActive: true, deletedAt: null } });
  if (!stockItem) throw new Error('Need an active stock item');
  const warehouse = await prisma.warehouse.findFirst({ where: { isActive: true } });
  if (!warehouse) throw new Error('Need an active warehouse');

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Expired stock lot — directly DB-seeded with a past `expiresAt`.
  const expiredLot = await prisma.stockLot.create({
    data: {
      stockItemId: stockItem.id,
      warehouseId: warehouse.id,
      lotCode: `EXP-LOT-${stamp}`,
      quantityReceived: 50,
      quantityOnHand: 50,
      unitCost: 1,
      expiresAt: yesterday,
      status: StockLotStatus.ACTIVE,
    },
  });

  // Active stock lot for the opened container — must be PARTIAL strategy item.
  const partialItem = await prisma.stockItem.findFirst({
    where: {
      consumptionStrategy: { in: [ConsumptionStrategy.PARTIAL_ALLOWED, ConsumptionStrategy.PARTIAL_REQUIRED] },
      conversionFactor: { not: null },
      secondaryUnitId: { not: null },
      isActive: true,
      deletedAt: null,
    },
  });
  if (!partialItem) throw new Error('Need a partial-allowed stock item with conversionFactor');

  const containerLot = await prisma.stockLot.create({
    data: {
      stockItemId: partialItem.id,
      warehouseId: warehouse.id,
      lotCode: `EXP-CONT-LOT-${stamp}`,
      quantityReceived: 5,
      quantityOnHand: 5,
      unitCost: 1,
      status: StockLotStatus.ACTIVE,
    },
  });
  const adminUser = await prisma.user.findFirst({ where: { email: 'admin@reverie.local' } });
  if (!adminUser) throw new Error('admin user missing');

  const expiredContainer = await prisma.openedContainer.create({
    data: {
      stockItemId: partialItem.id,
      stockLotId: containerLot.id,
      warehouseId: warehouse.id,
      openedByUserId: adminUser.id,
      expiryAt: yesterday,
      initialQtyPrimary: 100,
      remainingQtyPrimary: 100,
      status: OpenedContainerStatus.ACTIVE,
    },
  });

  // ── Login + run the sweep ──
  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    email: 'admin@reverie.local',
    password: 'Admin123!',
  });
  expect(login.body.success, 'admin login OK');
  const token = (login.body as ApiSuccess<{ accessToken: string }>).data.accessToken;

  const run1 = await call<{ lotsExpired: number; containersExpired: number; ranAt: string }>(
    'POST', '/admin/expiry-sweep/run', undefined, token,
  );
  expect(run1.status === 200, 'POST /admin/expiry-sweep/run returns 200');
  const result1 = (run1.body as ApiSuccess<{ lotsExpired: number; containersExpired: number; ranAt: string }>).data;
  expect(result1.lotsExpired >= 1, `lotsExpired >= 1 (got ${result1.lotsExpired})`);
  expect(result1.containersExpired >= 1, `containersExpired >= 1 (got ${result1.containersExpired})`);

  // ── Verify lot was flipped + zeroed + has an EXPIRE movement ──
  const lotAfter = await prisma.stockLot.findUnique({ where: { id: expiredLot.id } });
  expect(lotAfter!.status === 'EXPIRED', 'lot.status = EXPIRED');
  expect(decToNum(lotAfter!.quantityOnHand) === 0, 'lot.quantityOnHand zeroed');

  const expireMv = await prisma.stockMovement.findFirst({
    where: {
      stockLotId: expiredLot.id,
      type: StockMovementType.EXPIRE,
    },
  });
  expect(expireMv !== null, 'EXPIRE StockMovement created');
  expect(decToNum(expireMv!.quantityDelta) === -50, 'EXPIRE quantityDelta = -50 (previous on-hand)');
  expect(expireMv!.referenceType === 'EXPIRY_SWEEP', 'movement referenceType = EXPIRY_SWEEP');

  // ── Verify container was flipped ──
  const containerAfter = await prisma.openedContainer.findUnique({ where: { id: expiredContainer.id } });
  expect(containerAfter!.status === 'EXPIRED', 'container.status = EXPIRED');

  // ── Verify a second run is a no-op for these rows (idempotency) ──
  const movementsBefore = await prisma.stockMovement.count({
    where: { stockLotId: expiredLot.id, type: StockMovementType.EXPIRE },
  });
  const run2 = await call<{ lotsExpired: number; containersExpired: number }>(
    'POST', '/admin/expiry-sweep/run', undefined, token,
  );
  expect(run2.status === 200, 'second sweep returns 200');
  const movementsAfter = await prisma.stockMovement.count({
    where: { stockLotId: expiredLot.id, type: StockMovementType.EXPIRE },
  });
  expect(
    movementsBefore === movementsAfter,
    `second sweep is idempotent (${movementsBefore} EXPIRE movements before & after)`,
  );

  await prisma.$disconnect();
  console.log('\nALL EXPIRY-SWEEP SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILURE:', err);
  process.exit(1);
});
