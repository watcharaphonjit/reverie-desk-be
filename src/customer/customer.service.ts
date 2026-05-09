import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Customer, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
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
      await this.branches.validateBranchActive(dto.currentBranchId);
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await generateMonthlyCode(tx, 'CUST', 'customer-code');
      const customer = await tx.customer.create({
        data: {
          code,
          fullName: dto.fullName,
          phone: dto.phone,
          email: dto.email,
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
  async findAll(query: CustomerQueryDto): Promise<PaginatedResult<Customer>> {
    const page = query.page;
    const limit = query.limit;

    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      currentBranchId: query.branchId,
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

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
  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        currentBranch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const existing = await this.requireActive(id);

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
      await this.branches.validateBranchActive(dto.currentBranchId);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data: dto });
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
    const diff: Record<string, Prisma.InputJsonValue> = {};
    const fields: (keyof Customer)[] = [
      'fullName',
      'phone',
      'email',
      'notes',
      'currentBranchId',
    ];
    for (const f of fields) {
      const b = before[f];
      const a = after[f];
      if (b !== a) {
        diff[f] = {
          from: b == null ? null : b,
          to: a == null ? null : a,
        };
      }
    }
    return diff;
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
