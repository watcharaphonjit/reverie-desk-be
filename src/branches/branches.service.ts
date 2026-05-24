import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  AuditAction,
  Branch,
  BranchStatus,
  Prisma,
  StockTransferStatus,
  UserStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { isUnrestricted } from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { ListBranchesQuery } from './dto/list-branches.query';
import { UpdateBranchDto } from './dto/update-branch.dto';

const APPOINTMENT_ACTIVE: AppointmentStatus[] = [
  AppointmentStatus.BOOKED,
  AppointmentStatus.CHECKED_IN,
];

const STOCK_TRANSFER_PENDING: StockTransferStatus[] = [
  StockTransferStatus.DRAFT,
  StockTransferStatus.REQUESTED,
  StockTransferStatus.APPROVED,
  StockTransferStatus.IN_TRANSIT,
];

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(user: AuthenticatedUser, dto: CreateBranchDto): Promise<Branch> {
    const existing = await this.prisma.branch.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException(`Branch code "${dto.code}" already exists`);

    const branch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.branch.create({
        data: {
          code: dto.code,
          name: dto.name,
          phone: dto.phone,
          address: dto.address,
          status: dto.status ?? BranchStatus.ACTIVE,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: created.id,
        entityType: 'Branch',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: { code: created.code, name: created.name },
      });

      return created;
    });

    return branch;
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(query: ListBranchesQuery): Promise<PaginatedResult<Branch>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.BranchWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.branch.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { code: 'asc' },
      }),
      this.prisma.branch.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail with stats ─────────────────────────
  async findOne(user: AuthenticatedUser, id: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');
    this.assertReadAccess(user, branch.id);

    const [users, leads, customers, salesOrders] =
      await this.prisma.$transaction([
        this.prisma.user.count({ where: { branchId: id } }),
        this.prisma.lead.count({ where: { branchId: id, deletedAt: null } }),
        this.prisma.customer.count({
          where: { currentBranchId: id, deletedAt: null },
        }),
        this.prisma.salesOrder.count({ where: { branchId: id } }),
      ]);

    return {
      ...branch,
      stats: { users, leads, customers, salesOrders },
    };
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateBranchDto,
  ): Promise<Branch> {
    const branch = await this.requireBranch(id);

    if (
      dto.status === BranchStatus.INACTIVE &&
      branch.status === BranchStatus.ACTIVE
    ) {
      await this.assertCanDeactivate(id);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.branch.update({ where: { id }, data: dto });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.id,
        entityType: 'Branch',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: this.diffPayload(branch, updated),
      });
      return updated;
    });
  }

  // ───────────────────────── activate ─────────────────────────
  async activate(user: AuthenticatedUser, id: string): Promise<Branch> {
    const branch = await this.requireBranch(id);
    if (branch.status === BranchStatus.ACTIVE) return branch;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.branch.update({
        where: { id },
        data: { status: BranchStatus.ACTIVE },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.id,
        entityType: 'Branch',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: branch.status,
          to: BranchStatus.ACTIVE,
        },
      });
      return updated;
    });
  }

  // ───────────────────────── deactivate ─────────────────────────
  async deactivate(user: AuthenticatedUser, id: string): Promise<Branch> {
    const branch = await this.requireBranch(id);
    if (branch.status === BranchStatus.INACTIVE) return branch;

    await this.assertCanDeactivate(id);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.branch.update({
        where: { id },
        data: { status: BranchStatus.INACTIVE },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.id,
        entityType: 'Branch',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: branch.status,
          to: BranchStatus.INACTIVE,
        },
      });
      return updated;
    });
  }

  // ───────────────────────── reusable validators ─────────────────────────
  /**
   * Loads a branch by id and asserts it's ACTIVE. Designed to be called from
   * other modules (Leads, Users, Sales Orders, …) before persisting work
   * that targets a branch.
   *
   * @throws BadRequestException when branch is missing or inactive.
   */
  async validateBranchActive(branchId: string): Promise<Branch> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
    });
    if (!branch)
      throw new BadRequestException(`Branch ${branchId} does not exist`);
    if (branch.status !== BranchStatus.ACTIVE) {
      throw new BadRequestException(
        `Branch ${branch.code} is ${branch.status} and cannot accept new work`,
      );
    }
    return branch;
  }

  // ───────────────────────── helpers ─────────────────────────
  private async requireBranch(id: string): Promise<Branch> {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  private async assertCanDeactivate(branchId: string): Promise<void> {
    const [activeUsers, activeAppointments, pendingTransfers] =
      await this.prisma.$transaction([
        this.prisma.user.count({
          where: { branchId, status: UserStatus.ACTIVE },
        }),
        this.prisma.appointment.count({
          where: { branchId, status: { in: APPOINTMENT_ACTIVE } },
        }),
        this.prisma.stockTransfer.count({
          where: {
            status: { in: STOCK_TRANSFER_PENDING },
            OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
          },
        }),
      ]);

    const blockers: string[] = [];
    if (activeUsers > 0) blockers.push(`${activeUsers} active user(s)`);
    if (activeAppointments > 0) {
      blockers.push(`${activeAppointments} active appointment(s)`);
    }
    if (pendingTransfers > 0) {
      blockers.push(`${pendingTransfers} pending stock transfer(s)`);
    }

    if (blockers.length > 0) {
      throw new BadRequestException(
        `Cannot deactivate branch: ${blockers.join(', ')} still attached`,
      );
    }
  }

  private assertReadAccess(user: AuthenticatedUser, branchId: string): void {
    if (isUnrestricted(user)) return;
    if (user.roles.includes('BRANCH_MANAGER')) {
      if (user.branchId !== branchId) {
        throw new ForbiddenException(
          'Branch managers may only view their own branch',
        );
      }
      return;
    }
    throw new ForbiddenException('Insufficient role to view branch detail');
  }

  private diffPayload(before: Branch, after: Branch): Prisma.InputJsonValue {
    const diff: Record<string, Prisma.InputJsonValue> = {};
    if (before.name !== after.name) {
      diff.name = { from: before.name, to: after.name };
    }
    if (before.phone !== after.phone) {
      diff.phone = { from: before.phone, to: after.phone };
    }
    if (before.address !== after.address) {
      diff.address = { from: before.address, to: after.address };
    }
    if (before.status !== after.status) {
      diff.status = { from: before.status, to: after.status };
    }
    return diff;
  }
}
