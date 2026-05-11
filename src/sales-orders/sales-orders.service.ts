import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, SalesOrderStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { SalesOrderQueryDto } from './dto/sales-order-query.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';

const ORDER_INCLUDE = {
  customer: { select: { id: true, code: true, fullName: true, phone: true } },
  lead: { select: { id: true, code: true, name: true, status: true } },
  branch: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      service: {
        select: {
          id: true,
          code: true,
          name: true,
          isProgram: true,
          defaultSessions: true,
        },
      },
    },
  },
  payments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      amount: true,
      paymentMethod: true,
      paymentType: true,
      status: true,
      paidAt: true,
      createdAt: true,
      updatedAt: true,
      note: true,
      createdByUserId: true,
    },
  },
} satisfies Prisma.SalesOrderInclude;

type SalesOrderWithRelations = Prisma.SalesOrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

interface ItemDraft {
  serviceId: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  netAmount: number;
  snapshotServiceCode: string;
  snapshotServiceName: string;
  snapshotUnitPrice: number;
}

interface OrderTotals {
  subtotalAmount: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  drafts: ItemDraft[];
}

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branches: BranchesService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateSalesOrderDto,
  ): Promise<SalesOrderWithRelations> {
    assertBranchAccess(user, dto.branchId);
    await this.branches.validateBranchActive(dto.branchId);
    await this.assertCustomerExists(dto.customerId);
    if (dto.leadId) {
      await this.assertLeadConsistent(dto.leadId, dto.customerId, dto.branchId);
    }

    const totals = await this.buildTotals(dto.items, dto.taxAmount);
    this.assertDepositValid(dto.depositRequired, totals.totalAmount);

    return this.prisma.$transaction(async (tx) => {
      const orderNo = await generateOrderNo(tx);

      const order = await tx.salesOrder.create({
        data: {
          orderNo,
          branchId: dto.branchId,
          customerId: dto.customerId,
          leadId: dto.leadId ?? null,
          createdByUserId: user.id,
          status: SalesOrderStatus.DRAFT,
          ...(dto.currency ? { currency: dto.currency } : {}),
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          depositRequired: dto.depositRequired ?? 0,
          items: {
            create: totals.drafts.map((d) => ({
              serviceId: d.serviceId,
              quantity: d.quantity,
              unitPrice: d.unitPrice,
              discountAmount: d.discountAmount,
              netAmount: d.netAmount,
              snapshotServiceCode: d.snapshotServiceCode,
              snapshotServiceName: d.snapshotServiceName,
              snapshotUnitPrice: d.snapshotUnitPrice,
            })),
          },
        },
        include: ORDER_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: order.branchId,
        entityType: 'SalesOrder',
        entityId: order.id,
        action: AuditAction.CREATE,
        payload: {
          orderNo: order.orderNo,
          customerId: order.customerId,
          leadId: order.leadId,
          itemCount: totals.drafts.length,
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
        },
      });

      return order;
    });
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: SalesOrderQueryDto,
  ): Promise<PaginatedResult<SalesOrderWithRelations>> {
    if (query.branchId) assertBranchAccess(user, query.branchId);

    const where: Prisma.SalesOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.createdByUserId
        ? { createdByUserId: query.createdByUserId }
        : {}),
      ...(query.search
        ? { orderNo: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...this.branchScopeFilter(user, query.branchId),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.salesOrder.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: ORDER_INCLUDE,
      }),
      this.prisma.salesOrder.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<SalesOrderWithRelations> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Sales order not found');
    assertBranchAccess(user, order.branchId);
    return order;
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateSalesOrderDto,
  ): Promise<SalesOrderWithRelations> {
    const existing = await this.findOne(user, id);

    if (existing.status !== SalesOrderStatus.DRAFT) {
      throw new BadRequestException(
        `Sales order can only be edited while in DRAFT (current: ${existing.status})`,
      );
    }

    const itemsInput = dto.items ?? existing.items.map(toItemInput);
    const totals = await this.buildTotals(
      itemsInput,
      dto.taxAmount ?? Number(existing.taxAmount),
    );
    this.assertDepositValid(
      dto.depositRequired ?? Number(existing.depositRequired),
      totals.totalAmount,
    );

    return this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.salesOrderItem.deleteMany({ where: { salesOrderId: id } });
        await tx.salesOrderItem.createMany({
          data: totals.drafts.map((d) => ({
            salesOrderId: id,
            serviceId: d.serviceId,
            quantity: d.quantity,
            unitPrice: d.unitPrice,
            discountAmount: d.discountAmount,
            netAmount: d.netAmount,
            snapshotServiceCode: d.snapshotServiceCode,
            snapshotServiceName: d.snapshotServiceName,
            snapshotUnitPrice: d.snapshotUnitPrice,
          })),
        });
      }

      const updated = await tx.salesOrder.update({
        where: { id },
        data: {
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          ...(dto.depositRequired !== undefined
            ? { depositRequired: dto.depositRequired }
            : {}),
        },
        include: ORDER_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'SalesOrder',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          orderNo: updated.orderNo,
          itemsReplaced: dto.items !== undefined,
          totals: {
            subtotalAmount: totals.subtotalAmount,
            discountAmount: totals.discountAmount,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
          },
        },
      });

      return updated;
    });
  }

  // ───────────────────────── confirm ─────────────────────────
  async confirm(
    user: AuthenticatedUser,
    id: string,
    note?: string,
  ): Promise<SalesOrderWithRelations> {
    const existing = await this.findOne(user, id);
    if (existing.status !== SalesOrderStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT orders can be confirmed (current: ${existing.status})`,
      );
    }
    if (existing.items.length === 0) {
      throw new BadRequestException('Cannot confirm an empty sales order');
    }
    return this.transitionStatus(
      user,
      existing,
      SalesOrderStatus.CONFIRMED,
      note ? { note } : undefined,
    );
  }

  // ───────────────────────── cancel ─────────────────────────
  async cancel(
    user: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<SalesOrderWithRelations> {
    const existing = await this.findOne(user, id);
    const cancellable: ReadonlyArray<SalesOrderStatus> = [
      SalesOrderStatus.DRAFT,
      SalesOrderStatus.CONFIRMED,
    ];
    if (!cancellable.includes(existing.status)) {
      throw new BadRequestException(
        `Sales order in status ${existing.status} cannot be cancelled`,
      );
    }
    return this.transitionStatus(
      user,
      existing,
      SalesOrderStatus.CANCELLED,
      reason ? { reason } : undefined,
    );
  }

  // ───────────────────────── helpers ─────────────────────────
  private branchScopeFilter(
    user: AuthenticatedUser,
    requestedBranchId: string | undefined,
  ): Prisma.SalesOrderWhereInput {
    if (requestedBranchId) return { branchId: requestedBranchId };
    if (isUnrestricted(user)) return {};
    if (!user.branchId)
      throw new ForbiddenException('User has no branch assignment');
    return { branchId: user.branchId };
  }

  private async assertCustomerExists(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, deletedAt: true },
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException('Customer not found');
    }
  }

  private async assertLeadConsistent(
    leadId: string,
    customerId: string,
    branchId: string,
  ): Promise<void> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, customerId: true, branchId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.branchId !== branchId) {
      throw new BadRequestException(
        'Lead branch does not match sales order branch',
      );
    }
    if (lead.customerId && lead.customerId !== customerId) {
      throw new BadRequestException(
        'Lead is already linked to a different customer',
      );
    }
  }

  private assertDepositValid(deposit: number | undefined, total: number): void {
    if (deposit === undefined) return;
    if (deposit > total) {
      throw new BadRequestException(
        'Required deposit cannot exceed the total amount',
      );
    }
  }

  /**
   * Resolve every line item against the live Service catalogue, freeze the
   * snapshot fields, validate quantities/discounts, and roll the per-line
   * numbers up into the order-level totals.
   *
   * Discounts are line-level only — the order's `discountAmount` is the
   * straight sum of `items[].discountAmount`, so its name maps 1:1 to the
   * Prisma column. Whole-order coupons are spread across line items by the
   * caller (which also keeps commission and refund accounting correct).
   */
  private async buildTotals(
    items: Array<{
      serviceId: string;
      quantity: number;
      unitPrice?: number;
      discountAmount?: number;
    }>,
    taxAmount: number | undefined,
  ): Promise<OrderTotals> {
    if (items.length === 0) {
      throw new BadRequestException('Sales order requires at least one item');
    }

    const serviceIds = Array.from(new Set(items.map((i) => i.serviceId)));
    const services = await this.prisma.service.findMany({
      where: { id: { in: serviceIds }, isActive: true, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        basePrice: true,
      },
    });
    const byId = new Map(services.map((s) => [s.id, s]));
    const missing = serviceIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Service(s) not found or inactive: ${missing.join(', ')}`,
      );
    }

    const drafts: ItemDraft[] = [];
    let itemsSubtotal = 0;
    let itemsDiscount = 0;

    for (const input of items) {
      const service = byId.get(input.serviceId)!;
      const basePrice =
        service.basePrice == null ? null : Number(service.basePrice);
      const unitPrice = input.unitPrice ?? basePrice;
      if (unitPrice == null) {
        throw new BadRequestException(
          `Service ${service.code} has no base price; unitPrice is required`,
        );
      }

      const lineGross = round2(unitPrice * input.quantity);
      const lineDiscount = round2(input.discountAmount ?? 0);
      if (lineDiscount > lineGross) {
        throw new BadRequestException(
          `Line discount exceeds line subtotal for service ${service.code}`,
        );
      }
      const netAmount = round2(lineGross - lineDiscount);

      itemsSubtotal = round2(itemsSubtotal + lineGross);
      itemsDiscount = round2(itemsDiscount + lineDiscount);

      drafts.push({
        serviceId: service.id,
        quantity: input.quantity,
        unitPrice: round2(unitPrice),
        discountAmount: lineDiscount,
        netAmount,
        snapshotServiceCode: service.code,
        snapshotServiceName: service.name,
        snapshotUnitPrice: round2(unitPrice),
      });
    }

    const discountAmount = itemsDiscount;
    const tax = round2(taxAmount ?? 0);
    const totalAmount = round2(itemsSubtotal - discountAmount + tax);

    return {
      subtotalAmount: itemsSubtotal,
      discountAmount,
      taxAmount: tax,
      totalAmount,
      drafts,
    };
  }

  private async transitionStatus(
    user: AuthenticatedUser,
    existing: SalesOrderWithRelations,
    next: SalesOrderStatus,
    extra?: Record<string, string>,
  ): Promise<SalesOrderWithRelations> {
    const completedAt =
      next === SalesOrderStatus.COMPLETED ? new Date() : undefined;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.salesOrder.update({
        where: { id: existing.id },
        data: {
          status: next,
          ...(completedAt ? { completedAt } : {}),
        },
        include: ORDER_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'SalesOrder',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: existing.status,
          to: next,
          ...(extra ?? {}),
        },
      });

      return updated;
    });
  }
}

// ─────────────────────── module-private utils ───────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toItemInput = (
  item: SalesOrderWithRelations['items'][number],
): {
  serviceId: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
} => ({
  serviceId: item.serviceId,
  quantity: item.quantity,
  unitPrice: Number(item.unitPrice),
  discountAmount: Number(item.discountAmount),
});

/**
 * Concurrency-safe order-number generator using the same advisory-lock
 * pattern as customer/lead codes. Format: `SO-YYYYMM-####`.
 */
async function generateOrderNo(tx: Prisma.TransactionClient): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sales-order-no'))`;

  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prefix = `SO-${yyyymm}-`;

  const last = await tx.salesOrder.findFirst({
    where: { orderNo: { startsWith: prefix } },
    orderBy: { orderNo: 'desc' },
    select: { orderNo: true },
  });

  const lastSeq = last ? parseInt(last.orderNo.slice(prefix.length), 10) : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}
