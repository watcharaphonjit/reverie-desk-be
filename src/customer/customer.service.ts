import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Customer,
  Prisma,
  SalesOrderStatus,
  ServiceEventStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import {
  assertBranchAccess,
  scopedBranchFilter,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { composeFullName } from '../common/utils/name';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branches: BranchesService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateCustomerDto,
  ): Promise<Customer> {
    if (dto.phone) await this.assertPhoneAvailable(dto.phone);
    if (dto.email) await this.assertEmailAvailable(dto.email);
    if (dto.currentBranchId) {
      assertBranchAccess(user, dto.currentBranchId);
      await this.branches.validateBranchActive(dto.currentBranchId);
    }

    const fullName = composeFullName(dto);

    return this.prisma.$transaction(async (tx) => {
      const code = await generateMonthlyCode(tx, 'CUST', 'customer-code');
      const customer = await tx.customer.create({
        data: {
          code,
          fullName,
          title: dto.title,
          firstName: dto.firstName,
          middleName: dto.middleName,
          lastName: dto.lastName,
          nickname: dto.nickname,
          phone: dto.phone,
          email: dto.email,
          lineId: dto.lineId,
          gender: dto.gender,
          birthdate: dto.birthdate ?? null,
          address: dto.address,
          province: dto.province,
          postalCode: dto.postalCode,
          level: dto.level,
          isActive: dto.isActive,
          allergy: dto.allergy,
          notes: dto.notes,
          currentBranchId: dto.currentBranchId ?? null,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: customer.currentBranchId,
        entityType: 'Customer',
        entityId: customer.id,
        action: AuditAction.CREATE,
        payload: {
          code: customer.code,
          fullName: customer.fullName,
          currentBranchId: customer.currentBranchId,
        },
      });

      return customer;
    });
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: CustomerQueryDto,
  ): Promise<PaginatedResult<Customer>> {
    const page = query.page;
    const limit = query.limit;
    if (query.branchId) {
      assertBranchAccess(user, query.branchId);
    }

    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      currentBranchId: query.branchId ?? scopedBranchFilter(user),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { nickname: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { lineId: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    if (query.birthMonth) {
      const scopedBranch = query.branchId ?? scopedBranchFilter(user);
      const birthMonthIds = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM customers
        WHERE "deletedAt" IS NULL
          AND "birthdate" IS NOT NULL
          AND EXTRACT(MONTH FROM "birthdate") = ${query.birthMonth}
          ${scopedBranch ? Prisma.sql`AND "currentBranchId" = ${scopedBranch}` : Prisma.empty}
      `;
      const ids = birthMonthIds.map((row) => row.id);
      if (ids.length === 0) {
        return { data: [], meta: { page, limit, total: 0 } };
      }
      where.id = { in: ids };
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  /**
   * Customer detail including the three derived totals
   * (`totalSpent`, `visitCount`, `lastVisitAt`) the frontend needs for
   * the customer profile header. Computed live so we don't have to
   * keep a denormalized cache in sync with sales / service-event
   * mutations across multiple modules.
   */
  async findOne(user: AuthenticatedUser, id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        currentBranch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException('Customer not found');
    }
    assertBranchAccess(user, customer.currentBranchId);

    // Three independent aggregates, dispatched in parallel:
    //  1. Total spend = sum of paid/completed sales-order totals.
    //  2. Visit count = number of completed service events.
    //  3. Last visit  = most recent service-event completion timestamp.
    const [salesAgg, visitAgg, lastVisitRow] = await Promise.all([
      this.prisma.salesOrder.aggregate({
        where: {
          customerId: id,
          status: { in: [SalesOrderStatus.PAID, SalesOrderStatus.COMPLETED] },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.customerServiceEvent.count({
        where: {
          customerId: id,
          status: ServiceEventStatus.COMPLETED,
        },
      }),
      this.prisma.customerServiceEvent.findFirst({
        where: {
          customerId: id,
          status: ServiceEventStatus.COMPLETED,
          completedAt: { not: null },
        },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
    ]);

    return {
      ...customer,
      totalSpent: salesAgg._sum.totalAmount ?? new Prisma.Decimal(0),
      visitCount: visitAgg,
      lastVisitAt: lastVisitRow?.completedAt ?? null,
    };
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const existing = await this.requireActive(id);
    assertBranchAccess(user, existing.currentBranchId);

    if (dto.phone && dto.phone !== existing.phone) {
      await this.assertPhoneAvailable(dto.phone, id);
    }
    if (dto.email && dto.email !== existing.email) {
      await this.assertEmailAvailable(dto.email, id);
    }
    if (
      dto.currentBranchId &&
      dto.currentBranchId !== existing.currentBranchId
    ) {
      assertBranchAccess(user, dto.currentBranchId);
      await this.branches.validateBranchActive(dto.currentBranchId);
    }

    // Re-derive `fullName` whenever any name component is touched so
    // the cached column stays consistent with the split fields.
    const data: Prisma.CustomerUpdateInput = { ...dto };
    if (
      dto.title !== undefined ||
      dto.firstName !== undefined ||
      dto.middleName !== undefined ||
      dto.lastName !== undefined
    ) {
      data.fullName = composeFullName({
        title: dto.title ?? existing.title,
        firstName: dto.firstName ?? existing.firstName,
        middleName: dto.middleName ?? existing.middleName,
        lastName: dto.lastName ?? existing.lastName,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.currentBranchId,
        entityType: 'Customer',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: this.diffPayload(existing, updated),
      });
      return updated;
    });
  }

  // ───────────────────────── soft delete ─────────────────────────
  async remove(user: AuthenticatedUser, id: string): Promise<Customer> {
    const existing = await this.requireActive(id);
    assertBranchAccess(user, existing.currentBranchId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.currentBranchId,
        entityType: 'Customer',
        entityId: existing.id,
        action: AuditAction.DELETE,
        payload: { code: updated.code, softDelete: true },
      });
      return updated;
    });
  }

  // ───────────────────────── change branch ─────────────────────────
  async changeBranch(
    user: AuthenticatedUser,
    id: string,
    branchId: string,
  ): Promise<Customer> {
    const existing = await this.requireActive(id);
    assertBranchAccess(user, existing.currentBranchId);
    assertBranchAccess(user, branchId);
    await this.branches.validateBranchActive(branchId);

    if (existing.currentBranchId === branchId) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: { currentBranchId: branchId },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId,
        entityType: 'Customer',
        entityId: updated.id,
        action: AuditAction.TRANSFER,
        payload: {
          field: 'currentBranchId',
          from: existing.currentBranchId,
          to: branchId,
        },
      });
      return updated;
    });
  }

  // ───────────────────────── consumed by LeadsService ─────────────────────────
  /** Internal: find customer by phone or email (used by lead conversion). */
  async findByPhoneOrEmail(
    phone: string | null | undefined,
    email: string | null | undefined,
  ): Promise<Customer | null> {
    const filters: Prisma.CustomerWhereInput[] = [];
    if (phone) filters.push({ phone });
    if (email) filters.push({ email });
    if (filters.length === 0) return null;

    return this.prisma.customer.findFirst({
      where: { deletedAt: null, OR: filters },
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private async requireActive(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  private async assertPhoneAvailable(
    phone: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.customer.findUnique({
      where: { phone },
      select: { id: true, deletedAt: true },
    });
    if (existing && existing.id !== excludeId && !existing.deletedAt) {
      throw new ConflictException('Phone is already used by another customer');
    }
  }

  private async assertEmailAvailable(
    email: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true, deletedAt: true },
    });
    if (existing && existing.id !== excludeId && !existing.deletedAt) {
      throw new ConflictException('Email is already used by another customer');
    }
  }

  private diffPayload(
    before: Customer,
    after: Customer,
  ): Prisma.InputJsonValue {
    const fields: (keyof Customer)[] = [
      'fullName',
      'title',
      'firstName',
      'middleName',
      'lastName',
      'nickname',
      'phone',
      'email',
      'lineId',
      'gender',
      'address',
      'province',
      'postalCode',
      'level',
      'isActive',
      'allergy',
      'notes',
      'currentBranchId',
    ];
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of fields) {
      const b = before[f];
      const a = after[f];
      if (b !== a) {
        diff[f] = {
          from: b instanceof Date ? b.toISOString() : (b ?? null),
          to: a instanceof Date ? a.toISOString() : (a ?? null),
        };
      }
    }
    // Round-trip through JSON to drop any non-serializable fields and
    // collapse `Decimal`/`Date` instances to their JSON representation.
    return JSON.parse(JSON.stringify(diff)) as Prisma.InputJsonValue;
  }
}

/**
 * Concurrency-safe sequential code generator for the form `<PREFIX>-YYYYMM-####`.
 * Uses a Postgres advisory transaction lock keyed by `lockKey` so concurrent
 * inserts can't collide on the unique `code` index. Released automatically
 * when the surrounding `prisma.$transaction` commits or rolls back.
 *
 * Exported because LeadsService also uses it (with prefix `LEAD`) when
 * creating customers during lead conversion.
 */
export async function generateMonthlyCode(
  tx: Prisma.TransactionClient,
  prefix: 'CUST' | 'LEAD',
  lockKey: string,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const codePrefix = `${prefix}-${yyyymm}-`;

  const last =
    prefix === 'LEAD'
      ? await tx.lead.findFirst({
          where: { code: { startsWith: codePrefix } },
          orderBy: { code: 'desc' },
          select: { code: true },
        })
      : await tx.customer.findFirst({
          where: { code: { startsWith: codePrefix } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });

  const lastSeq = last ? parseInt(last.code.slice(codePrefix.length), 10) : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${codePrefix}${String(nextSeq).padStart(4, '0')}`;
}
