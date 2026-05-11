import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConsumptionStrategy,
  PrismaClient,
  StockItemType,
  StockLotStatus,
  StockMovementType,
  WarehouseType,
} from '@prisma/client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001/api/v1';
const REPORT_PATH =
  process.env.INVENTORY_REPORT_PATH ??
  'c:\\Users\\Ongaj\\Desktop\\projects\\clinic-sync\\docs\\verification\\inventory-phase-verification-local.md';

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
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

interface FixtureSet {
  activeWarehouse: {
    id: string;
    code: string;
    name: string;
    branchId: string | null;
    branchCode: string | null;
    branchName: string | null;
  };
  destinationWarehouse: {
    id: string;
    code: string;
    name: string;
    branchId: string | null;
    branchCode: string | null;
    branchName: string | null;
  };
  directConsumeItem: {
    id: string;
    sku: string;
    name: string;
    consumptionStrategy: ConsumptionStrategy;
  };
  partialItem: {
    id: string;
    sku: string;
    name: string;
    conversionFactor: number;
  };
  serviceEventSeed: {
    branchId: string;
    branchCode: string;
    branchName: string;
    customerId: string;
    customerCode: string;
    customerName: string;
    serviceId: string;
    serviceCode: string;
    serviceName: string;
  };
}

interface VerificationContext {
  prisma: PrismaClient;
  token: string;
  stamp: string;
  fixtures: FixtureSet;
  health: {
    status: number;
    body: ApiResponse<{
      status: string;
      info: Record<string, unknown>;
      error: Record<string, unknown>;
      details: Record<string, unknown>;
    }>;
  };
  evidence: {
    scenario1?: {
      lotId: string;
      movementId: string | null;
      stockItemId: string;
    };
    scenario2?: { movementId: string | null };
    scenario3?: {
      transferId: string;
      transferOutMovementId: string | null;
      transferInMovementId: string | null;
      destinationLotId: string | null;
    };
    scenario4?: { transferId: string };
    scenario5?: {
      containerId: string;
      openMovementId: string | null;
      stockLotId: string;
      serviceEventId: string;
    };
    scenario7?: { lotId: string; auditLogId: string | null };
    scenario8?: { discardMovementId: string | null };
    scenario9?: { consumeMovementId: string | null; consumeLotId: string };
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
  const parsed = text ? (JSON.parse(text) as ApiResponse<T>) : undefined;
  if (!parsed) {
    throw new Error(`${method} ${pathName} returned an empty response body`);
  }

  return { status: res.status, body: parsed };
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function getSuccessData<T>(result: CallResult<T>, message: string): T {
  expect(result.body.success, message);
  return (result.body as ApiSuccess<T>).data;
}

function decToNum(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return Number(String(value));
}

function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function branchLabel(input: {
  branchCode: string | null;
  branchName: string | null;
  code: string;
  name: string;
}): string {
  if (input.branchCode && input.branchName) {
    return `${input.branchCode} - ${input.branchName}`;
  }
  return `${input.code} - ${input.name}`;
}

async function createWalkInServiceEvent(
  context: VerificationContext,
  note: string,
): Promise<{ id: string; branchId: string; serviceId: string }> {
  const response = await call<{
    id: string;
    branch: { id: string; code: string; name: string };
    service: { id: string; code: string; name: string };
    status: string;
  }>(
    'POST',
    '/service-events',
    {
      customerId: context.fixtures.serviceEventSeed.customerId,
      branchId: context.fixtures.serviceEventSeed.branchId,
      serviceId: context.fixtures.serviceEventSeed.serviceId,
      notes: note,
    },
    context.token,
  );

  expect(
    response.status === 201,
    `service-event creation failed (${response.status})`,
  );
  const event = getSuccessData(
    response,
    'service-event creation returned an error envelope',
  );
  return {
    id: event.id,
    branchId: event.branch.id,
    serviceId: event.service.id,
  };
}

async function receiveStockLot(
  context: VerificationContext,
  input: {
    lotCode: string;
    stockItemId: string;
    warehouseId?: string;
    quantityReceived: number;
    unitCost?: number;
    expiresAt?: string;
    note: string;
  },
): Promise<
  CallResult<{
    id: string;
    lotCode: string;
    quantityOnHand: string;
    quantityReceived: string;
    status?: string;
    warehouse?: { id: string; code: string; name: string };
    stockItem?: { id: string; sku: string; name: string };
  }>
> {
  return call(
    'POST',
    '/stock-lots/receive',
    {
      stockItemId: input.stockItemId,
      warehouseId: input.warehouseId ?? context.fixtures.activeWarehouse.id,
      lotCode: input.lotCode,
      quantityReceived: input.quantityReceived,
      unitCost: input.unitCost ?? 1,
      expiresAt: input.expiresAt,
      note: input.note,
    },
    context.token,
  );
}

async function loadFixtures(prisma: PrismaClient): Promise<FixtureSet> {
  const activeWarehouse = await prisma.warehouse.findFirst({
    where: { isActive: true, branchId: { not: null } },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      branch: { select: { code: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  expect(!!activeWarehouse, 'No active warehouse with branch found');

  let destinationWarehouse = await prisma.warehouse.findFirst({
    where: {
      isActive: true,
      branchId: { not: null },
      id: { not: activeWarehouse!.id },
      NOT: { branchId: activeWarehouse!.branchId },
    },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      branch: { select: { code: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!destinationWarehouse) {
    destinationWarehouse = await prisma.warehouse.findFirst({
      where: { isActive: true, id: { not: activeWarehouse!.id } },
      select: {
        id: true,
        code: true,
        name: true,
        branchId: true,
        branch: { select: { code: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!destinationWarehouse) {
    const fallbackBranch = await prisma.branch.findFirst({
      where: {
        status: 'ACTIVE',
        id: { not: activeWarehouse!.branchId ?? undefined },
      },
      select: { id: true, code: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      !!fallbackBranch,
      'No fallback branch available for destination warehouse',
    );

    destinationWarehouse = await prisma.warehouse.create({
      data: {
        code: `VFY-${Date.now().toString().slice(-6)}`,
        name: 'Verification Transfer Warehouse',
        type: WarehouseType.BRANCH,
        isActive: true,
        branchId: fallbackBranch!.id,
      },
      select: {
        id: true,
        code: true,
        name: true,
        branchId: true,
        branch: { select: { code: true, name: true } },
      },
    });
  }

  const directConsumeItem = await prisma.stockItem.findFirst({
    where: {
      isActive: true,
      deletedAt: null,
      consumptionStrategy: { not: ConsumptionStrategy.PARTIAL_REQUIRED },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      consumptionStrategy: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  expect(
    !!directConsumeItem,
    'No active stock item available for direct consume testing',
  );

  let partialItem = await prisma.stockItem.findFirst({
    where: {
      isActive: true,
      deletedAt: null,
      consumptionStrategy: {
        in: [
          ConsumptionStrategy.PARTIAL_ALLOWED,
          ConsumptionStrategy.PARTIAL_REQUIRED,
        ],
      },
      conversionFactor: { not: null },
      secondaryUnitId: { not: null },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      conversionFactor: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!partialItem) {
    const bootstrapTarget = await prisma.stockItem.findFirst({
      where: {
        isActive: true,
        deletedAt: null,
        consumptionStrategy: {
          in: [
            ConsumptionStrategy.PARTIAL_ALLOWED,
            ConsumptionStrategy.PARTIAL_REQUIRED,
          ],
        },
      },
      select: {
        id: true,
        sku: true,
        name: true,
        primaryUnitId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (bootstrapTarget) {
      const secondaryUnit = await prisma.unit.findFirst({
        where: {
          isActive: true,
          id: { not: bootstrapTarget.primaryUnitId },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        !!secondaryUnit,
        'No secondary unit available to bootstrap partial stock item',
      );

      partialItem = await prisma.stockItem.update({
        where: { id: bootstrapTarget.id },
        data: {
          secondaryUnitId: secondaryUnit!.id,
          conversionFactor: 100,
        },
        select: {
          id: true,
          sku: true,
          name: true,
          conversionFactor: true,
        },
      });
    } else {
      let units = await prisma.unit.findMany({
        where: { isActive: true },
        select: { id: true, code: true, label: true },
        orderBy: { createdAt: 'asc' },
        take: 2,
      });

      if (units.length < 2) {
        const stamp = Date.now().toString().slice(-6);
        const createdUnit = await prisma.unit.create({
          data: {
            code: `VFYU${stamp}`,
            label: 'Verification Unit',
            isActive: true,
          },
          select: { id: true, code: true, label: true },
        });
        units = [...units, createdUnit];
      }

      expect(
        units.length >= 2,
        'Need at least two active units to create a partial stock item for verification',
      );

      const stamp = Date.now().toString().slice(-6);
      partialItem = await prisma.stockItem.create({
        data: {
          sku: `VFY-PART-${stamp}`,
          name: 'Verification Partial Stock Item',
          type: StockItemType.CLINICAL,
          primaryUnitId: units[0].id,
          secondaryUnitId: units[1].id,
          conversionFactor: 100,
          consumptionStrategy: ConsumptionStrategy.PARTIAL_ALLOWED,
          isSellable: false,
          trackLot: true,
          isActive: true,
        },
        select: {
          id: true,
          sku: true,
          name: true,
          conversionFactor: true,
        },
      });
    }
  }

  const branch =
    activeWarehouse!.branchId != null
      ? await prisma.branch.findUnique({
          where: { id: activeWarehouse!.branchId },
          select: { id: true, code: true, name: true, status: true },
        })
      : null;
  expect(
    branch?.status === 'ACTIVE',
    'Active warehouse branch is missing or inactive',
  );

  const customer = await prisma.customer.findFirst({
    where: { deletedAt: null },
    select: { id: true, code: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });
  expect(!!customer, 'No customer found for service-event setup');

  const service = await prisma.service.findFirst({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  expect(!!service, 'No active service found for service-event setup');

  return {
    activeWarehouse: {
      id: activeWarehouse!.id,
      code: activeWarehouse!.code,
      name: activeWarehouse!.name,
      branchId: activeWarehouse!.branchId,
      branchCode: activeWarehouse!.branch?.code ?? null,
      branchName: activeWarehouse!.branch?.name ?? null,
    },
    destinationWarehouse: {
      id: destinationWarehouse.id,
      code: destinationWarehouse.code,
      name: destinationWarehouse.name,
      branchId: destinationWarehouse.branchId,
      branchCode: destinationWarehouse.branch?.code ?? null,
      branchName: destinationWarehouse.branch?.name ?? null,
    },
    directConsumeItem: {
      id: directConsumeItem!.id,
      sku: directConsumeItem!.sku,
      name: directConsumeItem!.name,
      consumptionStrategy: directConsumeItem!.consumptionStrategy,
    },
    partialItem: {
      id: partialItem!.id,
      sku: partialItem!.sku,
      name: partialItem!.name,
      conversionFactor: decToNum(partialItem!.conversionFactor),
    },
    serviceEventSeed: {
      branchId: branch!.id,
      branchCode: branch!.code,
      branchName: branch!.name,
      customerId: customer!.id,
      customerCode: customer!.code,
      customerName: customer!.fullName,
      serviceId: service!.id,
      serviceCode: service!.code,
      serviceName: service!.name,
    },
  };
}

async function runScenario(
  title: string,
  action: () => Promise<{ summary: string; details: string[] }>,
): Promise<ScenarioRecord> {
  try {
    const result = await action();
    return {
      title,
      pass: true,
      summary: result.summary,
      details: result.details,
    };
  } catch (error) {
    return {
      title,
      pass: false,
      summary: shortError(error),
      details: [`Error: ${shortError(error)}`],
    };
  }
}

async function main(): Promise<void> {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = new PrismaClient({ adapter });

  try {
    const health = await call<{
      status: string;
      info: Record<string, unknown>;
      error: Record<string, unknown>;
      details: Record<string, unknown>;
    }>('GET', '/health');
    expect(health.status === 200, `health check failed (${health.status})`);
    expect(health.body.success, 'health check returned an error envelope');

    const login = await call<{ accessToken: string }>('POST', '/auth/login', {
      email: 'admin@reverie.local',
      password: 'Admin123!',
    });
    expect(
      login.status === 201 || login.status === 200,
      `login failed (${login.status})`,
    );
    const loginData = getSuccessData(login, 'login returned an error envelope');
    const token = loginData.accessToken;
    const fixtures = await loadFixtures(prisma);
    const stamp = Date.now().toString().slice(-6);

    const context: VerificationContext = {
      prisma,
      token,
      stamp,
      fixtures,
      health,
      evidence: {},
    };

    const scenarios: ScenarioRecord[] = [];

    scenarios.push(
      await runScenario('Scenario 1 - Receive Stock', async () => {
        const lotCode = `VFY-RCV-${context.stamp}`;
        const quantityReceived = 17;
        const response = await receiveStockLot(context, {
          lotCode,
          stockItemId: context.fixtures.directConsumeItem.id,
          quantityReceived,
          unitCost: 12.5,
          note: 'Inventory phase verification scenario 1',
        });

        expect(response.status === 201, `expected 201, got ${response.status}`);
        const lot = getSuccessData(
          response,
          'receive-stock returned an error envelope',
        );
        const persistedLot = await context.prisma.stockLot.findUnique({
          where: { id: lot.id },
          include: {
            warehouse: {
              include: {
                branch: { select: { code: true, name: true } },
              },
            },
          },
        });
        expect(!!persistedLot, 'newly received lot not found in database');
        expect(
          decToNum(persistedLot!.quantityOnHand) === quantityReceived,
          `quantityOnHand mismatch (${decToNum(persistedLot!.quantityOnHand)})`,
        );
        expect(
          persistedLot!.status === StockLotStatus.ACTIVE,
          `lot status mismatch (${persistedLot!.status})`,
        );

        const movement = await context.prisma.stockMovement.findFirst({
          where: {
            stockLotId: lot.id,
            type: StockMovementType.PURCHASE_IN,
          },
          orderBy: { createdAt: 'desc' },
        });
        context.evidence.scenario1 = {
          lotId: lot.id,
          movementId: movement?.id ?? null,
          stockItemId: context.fixtures.directConsumeItem.id,
        };

        return {
          summary: 'PASS - lot created ACTIVE with exact received quantity.',
          details: [
            `Stock item: ${context.fixtures.directConsumeItem.sku} - ${context.fixtures.directConsumeItem.name}`,
            `Lot ID: ${lot.id}`,
            `Quantity received: ${quantityReceived}`,
            `Branch: ${persistedLot!.warehouse.branch?.code ?? persistedLot!.warehouse.code} - ${persistedLot!.warehouse.branch?.name ?? persistedLot!.warehouse.name}`,
            `Resulting lot status: ${persistedLot!.status}`,
            `Movement ID: ${movement?.id ?? 'missing'}`,
            'Backend response:',
            jsonBlock({
              status: response.status,
              body: response.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario('Scenario 2 - Lot Adjustment', async () => {
        const lotId = context.evidence.scenario1?.lotId;
        expect(!!lotId, 'scenario 1 lot id missing');

        const beforeLot = await context.prisma.stockLot.findUnique({
          where: { id: lotId! },
        });
        expect(!!beforeLot, 'adjustment source lot missing');

        const beforeQty = decToNum(beforeLot!.quantityOnHand);
        const adjustmentDelta = 4;
        const afterQtyTarget = beforeQty + adjustmentDelta;
        const response = await call<{
          id: string;
          quantityOnHand: string;
          status: string;
        }>(
          'POST',
          `/stock-lots/${lotId}/adjust`,
          {
            quantityOnHand: afterQtyTarget,
            reason: 'PHYSICAL_RECOUNT',
            note: 'Inventory phase verification scenario 2',
          },
          context.token,
        );

        expect(
          response.status === 201 || response.status === 200,
          `expected 200/201, got ${response.status}`,
        );
        expect(response.body.success, 'adjustment returned an error envelope');

        const afterLot = await context.prisma.stockLot.findUnique({
          where: { id: lotId! },
        });
        expect(!!afterLot, 'adjusted lot missing after API call');
        expect(
          decToNum(afterLot!.quantityOnHand) === afterQtyTarget,
          `after quantity mismatch (${decToNum(afterLot!.quantityOnHand)})`,
        );

        const movement = await context.prisma.stockMovement.findFirst({
          where: {
            stockLotId: lotId!,
            type: StockMovementType.ADJUSTMENT,
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(!!movement, 'adjustment movement missing');
        expect(
          decToNum(movement!.quantityDelta) === adjustmentDelta,
          `adjustment delta mismatch (${decToNum(movement!.quantityDelta)})`,
        );
        context.evidence.scenario2 = { movementId: movement!.id };

        return {
          summary:
            'PASS - lot quantity updated and ledger contains ADJUSTMENT entry.',
          details: [
            `Lot ID: ${lotId}`,
            `Before qty: ${beforeQty}`,
            `Adjustment delta: +${adjustmentDelta}`,
            `After qty: ${decToNum(afterLot!.quantityOnHand)}`,
            'Reason: PHYSICAL_RECOUNT',
            `Ledger movement ID: ${movement!.id}`,
            'Backend response:',
            jsonBlock({
              status: response.status,
              body: response.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario('Scenario 3 - Transfer Lifecycle', async () => {
        const lotCode = `VFY-XFER-${context.stamp}`;
        const sourceQtyBefore = 11;
        const receiveResponse = await receiveStockLot(context, {
          lotCode,
          stockItemId: context.fixtures.directConsumeItem.id,
          quantityReceived: sourceQtyBefore,
          unitCost: 9.75,
          note: 'Inventory phase verification scenario 3 source lot',
        });
        expect(
          receiveResponse.status === 201,
          'transfer source lot receive failed',
        );
        const sourceLot = getSuccessData(
          receiveResponse,
          'transfer source lot receive returned error envelope',
        );
        const createResponse = await call<{
          id: string;
          status: string;
          transferNo: string;
          items: Array<{
            id: string;
            fromStockLotId: string;
            quantityRequested: string;
          }>;
        }>(
          'POST',
          '/stock-transfers',
          {
            fromWarehouseId: context.fixtures.activeWarehouse.id,
            toWarehouseId: context.fixtures.destinationWarehouse.id,
            note: 'Inventory phase verification scenario 3',
            items: [
              {
                stockItemId: context.fixtures.directConsumeItem.id,
                fromStockLotId: sourceLot.id,
                quantityRequested: 6,
              },
            ],
          },
          context.token,
        );
        expect(
          createResponse.status === 201,
          `transfer create failed (${createResponse.status})`,
        );
        const transfer = getSuccessData(
          createResponse,
          'transfer create returned error envelope',
        );
        const itemId = transfer.items[0]?.id;
        expect(!!itemId, 'transfer item missing');

        const requestResponse = await call<{ id: string; status: string }>(
          'PATCH',
          `/stock-transfers/${transfer.id}/request`,
          undefined,
          context.token,
        );
        expect(
          requestResponse.status === 200,
          `request transition failed (${requestResponse.status})`,
        );
        expect(
          requestResponse.body.success,
          'request transition returned error envelope',
        );

        const approveResponse = await call<{ id: string; status: string }>(
          'PATCH',
          `/stock-transfers/${transfer.id}/approve`,
          undefined,
          context.token,
        );
        expect(
          approveResponse.status === 200,
          `approve transition failed (${approveResponse.status})`,
        );
        expect(
          approveResponse.body.success,
          'approve transition returned error envelope',
        );

        const dispatchResponse = await call<{
          id: string;
          status: string;
          items: Array<{ id: string; quantitySent: string | null }>;
        }>(
          'POST',
          `/stock-transfers/${transfer.id}/dispatch`,
          {
            items: [{ itemId, quantitySent: 6 }],
            note: 'Inventory phase verification scenario 3 dispatch',
          },
          context.token,
        );
        expect(
          dispatchResponse.status === 200,
          `dispatch failed (${dispatchResponse.status})`,
        );
        expect(
          dispatchResponse.body.success,
          'dispatch returned error envelope',
        );

        const sourceAfterDispatch = await context.prisma.stockLot.findUnique({
          where: { id: sourceLot.id },
        });
        expect(!!sourceAfterDispatch, 'source lot missing after dispatch');
        expect(
          decToNum(sourceAfterDispatch!.quantityOnHand) === sourceQtyBefore - 6,
          `unexpected source qty after dispatch (${decToNum(sourceAfterDispatch!.quantityOnHand)})`,
        );

        const receiveTransferResponse = await call<{
          id: string;
          status: string;
          items: Array<{
            id: string;
            quantityReceived: string | null;
            toStockLotId: string | null;
          }>;
        }>(
          'POST',
          `/stock-transfers/${transfer.id}/receive`,
          {
            items: [{ itemId, quantityReceived: 6 }],
            note: 'Inventory phase verification scenario 3 receive',
          },
          context.token,
        );
        expect(
          receiveTransferResponse.status === 200,
          `receive failed (${receiveTransferResponse.status})`,
        );
        const receiveTransferData = getSuccessData(
          receiveTransferResponse,
          'receive returned error envelope',
        );

        const receivedItem = receiveTransferData.items[0];
        expect(
          !!receivedItem?.toStockLotId,
          'destination lot id missing after receive',
        );
        const destinationLot = await context.prisma.stockLot.findUnique({
          where: { id: receivedItem.toStockLotId! },
        });
        expect(!!destinationLot, 'destination lot missing after receive');
        expect(
          decToNum(destinationLot!.quantityOnHand) === 6,
          `unexpected destination qty (${decToNum(destinationLot!.quantityOnHand)})`,
        );

        const transferOutMovement =
          await context.prisma.stockMovement.findFirst({
            where: {
              referenceId: transfer.id,
              type: StockMovementType.TRANSFER_OUT,
            },
            orderBy: { createdAt: 'asc' },
          });
        const transferInMovement = await context.prisma.stockMovement.findFirst(
          {
            where: {
              referenceId: transfer.id,
              type: StockMovementType.TRANSFER_IN,
            },
            orderBy: { createdAt: 'asc' },
          },
        );
        expect(!!transferOutMovement, 'TRANSFER_OUT movement missing');
        expect(!!transferInMovement, 'TRANSFER_IN movement missing');
        expect(
          decToNum(transferOutMovement!.quantityDelta) === -6,
          `TRANSFER_OUT delta mismatch (${decToNum(transferOutMovement!.quantityDelta)})`,
        );
        expect(
          decToNum(transferInMovement!.quantityDelta) === 6,
          `TRANSFER_IN delta mismatch (${decToNum(transferInMovement!.quantityDelta)})`,
        );
        context.evidence.scenario3 = {
          transferId: transfer.id,
          transferOutMovementId: transferOutMovement!.id,
          transferInMovementId: transferInMovement!.id,
          destinationLotId: destinationLot!.id,
        };

        return {
          summary:
            'PASS - request, approve, dispatch, and receive all succeeded with exact inventory conservation.',
          details: [
            `Transfer ID: ${transfer.id}`,
            `Source branch: ${branchLabel(context.fixtures.activeWarehouse)}`,
            `Destination branch: ${branchLabel(context.fixtures.destinationWarehouse)}`,
            `Qty before source: ${sourceQtyBefore}`,
            `Qty after source: ${decToNum(sourceAfterDispatch!.quantityOnHand)}`,
            `Qty at destination: ${decToNum(destinationLot!.quantityOnHand)}`,
            `State transitions: ${['DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED'].join(' -> ')}`,
            `TRANSFER_OUT movement ID: ${transferOutMovement!.id}`,
            `TRANSFER_IN movement ID: ${transferInMovement!.id}`,
            'Create response:',
            jsonBlock({
              status: createResponse.status,
              body: createResponse.body,
            }),
            'Request response:',
            jsonBlock({
              status: requestResponse.status,
              body: requestResponse.body,
            }),
            'Approve response:',
            jsonBlock({
              status: approveResponse.status,
              body: approveResponse.body,
            }),
            'Dispatch response:',
            jsonBlock({
              status: dispatchResponse.status,
              body: dispatchResponse.body,
            }),
            'Receive response:',
            jsonBlock({
              status: receiveTransferResponse.status,
              body: receiveTransferResponse.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario('Scenario 4 - Reject / Cancel Transfer', async () => {
        const lotCode = `VFY-CANCEL-${context.stamp}`;
        const sourceQty = 9;
        const receiveResponse = await receiveStockLot(context, {
          lotCode,
          stockItemId: context.fixtures.directConsumeItem.id,
          quantityReceived: sourceQty,
          unitCost: 5.5,
          note: 'Inventory phase verification scenario 4 source lot',
        });
        expect(
          receiveResponse.status === 201,
          'cancel source lot receive failed',
        );
        const cancelReceiveData = getSuccessData(
          receiveResponse,
          'cancel source lot receive returned error envelope',
        );

        const sourceLotId = cancelReceiveData.id;
        const beforeLot = await context.prisma.stockLot.findUnique({
          where: { id: sourceLotId },
        });
        expect(!!beforeLot, 'cancel source lot missing before transfer');

        const createResponse = await call<{
          id: string;
          status: string;
          items: Array<{ id: string }>;
        }>(
          'POST',
          '/stock-transfers',
          {
            fromWarehouseId: context.fixtures.activeWarehouse.id,
            toWarehouseId: context.fixtures.destinationWarehouse.id,
            note: 'Inventory phase verification scenario 4',
            items: [
              {
                stockItemId: context.fixtures.directConsumeItem.id,
                fromStockLotId: sourceLotId,
                quantityRequested: 4,
              },
            ],
          },
          context.token,
        );
        expect(
          createResponse.status === 201,
          `cancel transfer create failed (${createResponse.status})`,
        );
        const cancelCreateData = getSuccessData(
          createResponse,
          'cancel transfer create returned error envelope',
        );

        const requestResponse = await call<{ id: string; status: string }>(
          'PATCH',
          `/stock-transfers/${cancelCreateData.id}/request`,
          undefined,
          context.token,
        );
        expect(
          requestResponse.status === 200,
          `request before cancel failed (${requestResponse.status})`,
        );
        expect(
          requestResponse.body.success,
          'request before cancel returned error envelope',
        );

        const cancelResponse = await call<{ id: string; status: string }>(
          'PATCH',
          `/stock-transfers/${cancelCreateData.id}/cancel`,
          { reason: 'Inventory phase verification scenario 4' },
          context.token,
        );
        expect(
          cancelResponse.status === 200,
          `cancel failed (${cancelResponse.status})`,
        );
        const cancelData = getSuccessData(
          cancelResponse,
          'cancel returned error envelope',
        );
        expect(
          cancelData.status === 'CANCELLED',
          `unexpected cancel status (${cancelData.status})`,
        );

        const afterLot = await context.prisma.stockLot.findUnique({
          where: { id: sourceLotId },
        });
        expect(!!afterLot, 'cancel source lot missing after cancel');
        expect(
          decToNum(afterLot!.quantityOnHand) ===
            decToNum(beforeLot!.quantityOnHand),
          'source inventory changed after cancelled transfer',
        );
        context.evidence.scenario4 = {
          transferId: cancelCreateData.id,
        };

        return {
          summary: 'PASS - cancelled transfer left source inventory unchanged.',
          details: [
            `Transfer ID: ${cancelCreateData.id}`,
            `Source inventory before: ${decToNum(beforeLot!.quantityOnHand)}`,
            `Source inventory after: ${decToNum(afterLot!.quantityOnHand)}`,
            'Create response:',
            jsonBlock({
              status: createResponse.status,
              body: createResponse.body,
            }),
            'Request response:',
            jsonBlock({
              status: requestResponse.status,
              body: requestResponse.body,
            }),
            'Cancel response:',
            jsonBlock({
              status: cancelResponse.status,
              body: cancelResponse.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario(
        'Scenario 5 - Opened Container Consumption',
        async () => {
          const event = await createWalkInServiceEvent(
            context,
            'Inventory phase verification scenario 5 service event',
          );
          const lotCode = `VFY-OPEN-${context.stamp}`;
          const receiveResponse = await receiveStockLot(context, {
            lotCode,
            stockItemId: context.fixtures.partialItem.id,
            quantityReceived: 3,
            unitCost: 4.25,
            note: 'Inventory phase verification scenario 5 lot',
          });
          expect(
            receiveResponse.status === 201,
            'opened-container source lot receive failed',
          );
          const openReceiveData = getSuccessData(
            receiveResponse,
            'opened-container source lot receive returned error envelope',
          );

          const lotId = openReceiveData.id;
          const openResponse = await call<{
            id: string;
            initialQtyPrimary: string;
            remainingQtyPrimary: string;
            status: string;
          }>(
            'POST',
            '/opened-containers',
            {
              stockLotId: lotId,
              note: 'Inventory phase verification scenario 5 container',
            },
            context.token,
          );
          expect(
            openResponse.status === 201,
            `open container failed (${openResponse.status})`,
          );
          const openData = getSuccessData(
            openResponse,
            'open container returned error envelope',
          );

          const container = openData;
          const consumedQty = Math.min(
            25,
            context.fixtures.partialItem.conversionFactor / 2,
          );
          const useResponse = await call<{
            id: string;
            remainingQtyPrimary: string;
            status: string;
          }>(
            'POST',
            `/opened-containers/${container.id}/use`,
            {
              customerServiceEventId: event.id,
              serviceId: event.serviceId,
              quantityPrimaryUsed: consumedQty,
              note: 'Inventory phase verification scenario 5 usage',
            },
            context.token,
          );
          expect(
            useResponse.status === 200,
            `container use failed (${useResponse.status})`,
          );
          const useData = getSuccessData(
            useResponse,
            'container use returned error envelope',
          );

          const expectedRemaining =
            decToNum(container.initialQtyPrimary) - consumedQty;
          expect(
            decToNum(useData.remainingQtyPrimary) === expectedRemaining,
            `remaining mismatch (${decToNum(useData.remainingQtyPrimary)})`,
          );

          const openMovement = await context.prisma.stockMovement.findFirst({
            where: {
              referenceId: container.id,
              type: StockMovementType.CLINICAL_USAGE,
              referenceType: 'OPENED_CONTAINER',
            },
            orderBy: { createdAt: 'asc' },
          });
          context.evidence.scenario5 = {
            containerId: container.id,
            openMovementId: openMovement?.id ?? null,
            stockLotId: lotId,
            serviceEventId: event.id,
          };

          return {
            summary:
              'PASS - opened container remaining quantity tracked correctly after partial usage.',
            details: [
              `Container ID: ${container.id}`,
              `Initial qty: ${decToNum(container.initialQtyPrimary)}`,
              `Consumed qty: ${consumedQty}`,
              `Remaining qty: ${decToNum(useData.remainingQtyPrimary)}`,
              `Service event ID: ${event.id}`,
              `Open movement ID: ${openMovement?.id ?? 'missing'}`,
              'Open response:',
              jsonBlock({
                status: openResponse.status,
                body: openResponse.body,
              }),
              'Use response:',
              jsonBlock({ status: useResponse.status, body: useResponse.body }),
            ],
          };
        },
      ),
    );

    scenarios.push(
      await runScenario(
        'Scenario 6 - Over-consumption Protection',
        async () => {
          const containerId = context.evidence.scenario5?.containerId;
          const serviceEventId = context.evidence.scenario5?.serviceEventId;
          expect(
            !!containerId && !!serviceEventId,
            'scenario 5 evidence missing',
          );

          const container = await context.prisma.openedContainer.findUnique({
            where: { id: containerId! },
          });
          expect(
            !!container,
            'container missing before over-consumption attempt',
          );

          const overConsumeResponse = await call(
            'POST',
            `/opened-containers/${containerId}/use`,
            {
              customerServiceEventId: serviceEventId,
              serviceId: context.fixtures.serviceEventSeed.serviceId,
              quantityPrimaryUsed: decToNum(container!.remainingQtyPrimary) + 1,
              note: 'Inventory phase verification scenario 6 over-consume',
            },
            context.token,
          );
          expect(
            overConsumeResponse.status === 400,
            `expected 400 rejection, got ${overConsumeResponse.status}`,
          );
          expect(
            !overConsumeResponse.body.success,
            'over-consumption unexpectedly succeeded',
          );

          return {
            summary:
              'PASS - over-consumption attempt was rejected with HTTP 400.',
            details: [
              `Container ID: ${containerId}`,
              `Available before attempt: ${decToNum(container!.remainingQtyPrimary)}`,
              `Attempted quantity: ${decToNum(container!.remainingQtyPrimary) + 1}`,
              'Backend response:',
              jsonBlock({
                status: overConsumeResponse.status,
                body: overConsumeResponse.body,
              }),
            ],
          };
        },
      ),
    );

    scenarios.push(
      await runScenario('Scenario 7 - Expiry / Quarantine', async () => {
        const event = await createWalkInServiceEvent(
          context,
          'Inventory phase verification scenario 7 service event',
        );
        const lotCode = `VFY-QRN-${context.stamp}`;
        const expiresAt = new Date(
          Date.now() + 3 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const receiveResponse = await receiveStockLot(context, {
          lotCode,
          stockItemId: context.fixtures.directConsumeItem.id,
          quantityReceived: 5,
          unitCost: 3.5,
          expiresAt,
          note: 'Inventory phase verification scenario 7 expiring lot',
        });
        expect(
          receiveResponse.status === 201,
          'quarantine source lot receive failed',
        );
        const quarantineReceiveData = getSuccessData(
          receiveResponse,
          'quarantine source lot receive returned error envelope',
        );

        const lotId = quarantineReceiveData.id;
        const quarantineResponse = await call<{
          id: string;
          status: string;
          quantityOnHand: string;
        }>(
          'PATCH',
          `/stock-lots/${lotId}/quarantine`,
          { reason: 'Inventory phase verification scenario 7' },
          context.token,
        );
        expect(
          quarantineResponse.status === 200,
          `quarantine failed (${quarantineResponse.status})`,
        );
        const quarantineData = getSuccessData(
          quarantineResponse,
          'quarantine returned error envelope',
        );
        expect(
          quarantineData.status === StockLotStatus.QUARANTINED,
          `unexpected quarantine status (${quarantineData.status})`,
        );

        const blockedConsumeResponse = await call(
          'POST',
          `/service-events/${event.id}/consume-stock`,
          {
            stockLotId: lotId,
            quantity: 1,
            note: 'Inventory phase verification scenario 7 blocked consume',
          },
          context.token,
        );
        expect(
          blockedConsumeResponse.status === 400,
          `expected blocked consume 400, got ${blockedConsumeResponse.status}`,
        );
        expect(
          !blockedConsumeResponse.body.success,
          'blocked consume unexpectedly succeeded',
        );

        const quarantineAudit = await context.prisma.auditLog.findFirst({
          where: {
            entityType: 'StockLot',
            entityId: lotId,
            action: 'UPDATE',
          },
          orderBy: { createdAt: 'desc' },
        });
        const quarantineAuditOp =
          quarantineAudit?.payload &&
          typeof quarantineAudit.payload === 'object' &&
          !Array.isArray(quarantineAudit.payload)
            ? (quarantineAudit.payload as Record<string, unknown>).op
            : undefined;
        expect(
          quarantineAuditOp === 'quarantine',
          'quarantine audit log entry missing',
        );

        context.evidence.scenario7 = {
          lotId,
          auditLogId: quarantineAudit?.id ?? null,
        };

        return {
          summary:
            'PASS - quarantine transition succeeded and subsequent consumption was blocked.',
          details: [
            `Lot ID: ${lotId}`,
            `Expiry at: ${expiresAt}`,
            `Status after quarantine: ${quarantineData.status}`,
              `Quarantine audit log ID: ${quarantineAudit?.id ?? 'missing'}`,
            'Quarantine response:',
            jsonBlock({
              status: quarantineResponse.status,
              body: quarantineResponse.body,
            }),
            'Blocked consume response:',
            jsonBlock({
              status: blockedConsumeResponse.status,
              body: blockedConsumeResponse.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario('Scenario 8 - Dispose Flow', async () => {
        const lotId = context.evidence.scenario7?.lotId;
        expect(!!lotId, 'scenario 7 lot id missing');

        const beforeLot = await context.prisma.stockLot.findUnique({
          where: { id: lotId! },
        });
        expect(!!beforeLot, 'dispose lot missing before request');

        const disposeResponse = await call<{
          id: string;
          status: string;
          quantityOnHand: string;
        }>(
          'PATCH',
          `/stock-lots/${lotId}/dispose`,
          { reason: 'Inventory phase verification scenario 8' },
          context.token,
        );
        expect(
          disposeResponse.status === 200,
          `dispose failed (${disposeResponse.status})`,
        );
        expect(disposeResponse.body.success, 'dispose returned error envelope');

        const afterLot = await context.prisma.stockLot.findUnique({
          where: { id: lotId! },
        });
        expect(!!afterLot, 'dispose lot missing after request');
        expect(
          afterLot!.status === StockLotStatus.DISCARDED,
          `unexpected dispose status (${afterLot!.status})`,
        );
        expect(
          decToNum(afterLot!.quantityOnHand) === 0,
          `dispose did not zero quantity (${decToNum(afterLot!.quantityOnHand)})`,
        );

        const movement = await context.prisma.stockMovement.findFirst({
          where: {
            stockLotId: lotId!,
            type: StockMovementType.DISCARD,
            referenceType: 'STOCK_LOT',
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(!!movement, 'dispose movement missing');
        expect(
          decToNum(movement!.quantityDelta) ===
            -decToNum(beforeLot!.quantityOnHand),
          `dispose delta mismatch (${decToNum(movement!.quantityDelta)})`,
        );

        const terminalConsumeResponse = await call(
          'POST',
          `/service-events/${(await createWalkInServiceEvent(context, 'Inventory phase verification scenario 8 service event')).id}/consume-stock`,
          {
            stockLotId: lotId,
            quantity: 1,
            note: 'Inventory phase verification scenario 8 terminal consume',
          },
          context.token,
        );
        expect(
          terminalConsumeResponse.status === 400,
          `expected terminal consume 400, got ${terminalConsumeResponse.status}`,
        );

        context.evidence.scenario8 = {
          discardMovementId: movement!.id,
        };

        return {
          summary:
            'PASS - disposed lot moved to terminal state and quantity was zeroed.',
          details: [
            `Lot ID: ${lotId}`,
            `Quantity before dispose: ${decToNum(beforeLot!.quantityOnHand)}`,
            `Quantity after dispose: ${decToNum(afterLot!.quantityOnHand)}`,
            `Status after dispose: ${afterLot!.status}`,
            `DISCARD movement ID: ${movement!.id}`,
            'Dispose response:',
            jsonBlock({
              status: disposeResponse.status,
              body: disposeResponse.body,
            }),
            'Terminal-state consume response:',
            jsonBlock({
              status: terminalConsumeResponse.status,
              body: terminalConsumeResponse.body,
            }),
          ],
        };
      }),
    );

    scenarios.push(
      await runScenario('Scenario 9 - Movement Ledger Integrity', async () => {
        const directConsumeEvent = await createWalkInServiceEvent(
          context,
          'Inventory phase verification scenario 9 direct consume event',
        );
        const consumeReceive = await receiveStockLot(context, {
          lotCode: `VFY-CSM-${context.stamp}`,
          stockItemId: context.fixtures.directConsumeItem.id,
          quantityReceived: 4,
          unitCost: 2.25,
          note: 'Inventory phase verification scenario 9 consume lot',
        });
        expect(
          consumeReceive.status === 201,
          'scenario 9 consume lot receive failed',
        );
        const consumeReceiveData = getSuccessData(
          consumeReceive,
          'scenario 9 consume lot receive returned error envelope',
        );

        const consumeLotId = consumeReceiveData.id;
        const consumeResponse = await call<{
          id: string;
          stockUsages: Array<{ id: string }>;
        }>(
          'POST',
          `/service-events/${directConsumeEvent.id}/consume-stock`,
          {
            stockLotId: consumeLotId,
            quantity: 1,
            note: 'Inventory phase verification scenario 9 direct consume',
          },
          context.token,
        );
        expect(
          consumeResponse.status === 200,
          `scenario 9 consume failed (${consumeResponse.status})`,
        );
        expect(
          consumeResponse.body.success,
          'scenario 9 consume returned error envelope',
        );

        const consumeMovement = await context.prisma.stockMovement.findFirst({
          where: {
            stockLotId: consumeLotId,
            type: StockMovementType.CLINICAL_USAGE,
            referenceType: 'CUSTOMER_SERVICE_EVENT',
            referenceId: directConsumeEvent.id,
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(!!consumeMovement, 'direct consume movement missing');
        context.evidence.scenario9 = {
          consumeMovementId: consumeMovement!.id,
          consumeLotId,
        };

        const ledgerChecks = [
          {
            label: 'Receive Stock',
            present: !!context.evidence.scenario1?.movementId,
            actual: 'PURCHASE_IN',
            note: 'Maps to business action RECEIVE.',
          },
          {
            label: 'Lot Adjustment',
            present: !!context.evidence.scenario2?.movementId,
            actual: 'ADJUSTMENT',
            note: 'Maps to business action ADJUST.',
          },
          {
            label: 'Transfer Out',
            present: !!context.evidence.scenario3?.transferOutMovementId,
            actual: 'TRANSFER_OUT',
            note: 'Created at dispatch.',
          },
          {
            label: 'Transfer In',
            present: !!context.evidence.scenario3?.transferInMovementId,
            actual: 'TRANSFER_IN',
            note: 'Created at receive.',
          },
          {
            label: 'Open Container',
            present: !!context.evidence.scenario5?.openMovementId,
            actual: 'CLINICAL_USAGE / referenceType=OPENED_CONTAINER',
            note: 'Open-container deduction uses CLINICAL_USAGE with OPENED_CONTAINER reference.',
          },
          {
            label: 'Consume Stock',
            present: !!context.evidence.scenario9?.consumeMovementId,
            actual: 'CLINICAL_USAGE / referenceType=CUSTOMER_SERVICE_EVENT',
            note: 'Direct lot consumption uses CLINICAL_USAGE with CUSTOMER_SERVICE_EVENT reference.',
          },
          {
            label: 'Quarantine',
            present: !!context.evidence.scenario7?.auditLogId,
            actual: 'AuditLog UPDATE / payload.op=quarantine',
            note: 'Backend records quarantine in audit_logs rather than stock_movements.',
          },
          {
            label: 'Dispose',
            present: !!context.evidence.scenario8?.discardMovementId,
            actual: 'DISCARD',
            note: 'Maps to business action DISPOSE.',
          },
        ];

        const apiLedgerSnapshot = await call<{
          data: Array<{
            id: string;
            type: string;
            referenceType: string | null;
            referenceId: string | null;
          }>;
          meta: { total: number };
        }>(
          'GET',
          `/stock-movements?search=${encodeURIComponent(context.evidence.scenario3?.transferId ?? '')}&limit=20`,
          undefined,
          context.token,
        );
        expect(
          apiLedgerSnapshot.status === 200,
          `stock-movements listing failed (${apiLedgerSnapshot.status})`,
        );
        expect(
          apiLedgerSnapshot.body.success,
          'stock-movements listing returned error envelope',
        );

        const missingRows = ledgerChecks.filter((check) => !check.present);
        expect(
          missingRows.length === 0,
          `Missing ledger coverage: ${missingRows.map((item) => `${item.label} [${item.actual}]`).join(', ')}`,
        );

        return {
          summary:
            'PASS - stock movement ledger contains all expected inventory actions.',
          details: [
            `Direct consume lot ID: ${consumeLotId}`,
            `Direct consume movement ID: ${consumeMovement!.id}`,
            'Ledger coverage:',
            jsonBlock(ledgerChecks),
            'API stock-movements snapshot:',
            jsonBlock({
              status: apiLedgerSnapshot.status,
              body: apiLedgerSnapshot.body,
            }),
            'Direct consume response:',
            jsonBlock({
              status: consumeResponse.status,
              body: consumeResponse.body,
            }),
          ],
        };
      }),
    );

    const overallPass = scenarios.every((scenario) => scenario.pass);
    const markdown = [
      '# Inventory Phase Verification',
      '',
      '- Environment: LOCAL',
      `- Date: ${new Date().toISOString()}`,
      `- Backend base URL: ${BASE_URL}`,
      `- Local database used: ${process.env.DATABASE_URL ?? 'DATABASE_URL not set'}`,
      `- Backend health confirmation: ${context.health.status}`,
      `- Overall result: ${overallPass ? 'PASS' : 'FAIL'}`,
      '',
      '## Backend Health Confirmation',
      '',
      jsonBlock({
        status: context.health.status,
        body: context.health.body,
      }),
      '',
      ...scenarios.flatMap((scenario, index) => [
        `## Scenario ${index + 1}`,
        '',
        `**Title:** ${scenario.title}`,
        '',
        `**Result:** ${scenario.pass ? 'PASS' : 'FAIL'}`,
        '',
        `**Summary:** ${scenario.summary}`,
        '',
        ...scenario.details.map((detail) => (detail === '' ? '' : detail)),
        '',
      ]),
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
  console.error('INVENTORY VERIFICATION FAILED:', error);
  process.exit(1);
});
