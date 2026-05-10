import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Lead,
  LeadStatus,
  Prisma,
  RoleCode,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { composeFullName } from '../common/utils/name';
import {
  CustomerService,
  generateMonthlyCode,
} from '../customer/customer.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssignLeadDto } from './dto/assign-lead.dto';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQuery } from './dto/list-leads.query';
import { UpdateLeadStatusDto } from './dto/update-status.dto';

/** A lead automatically expires this many days after creation. */
const LEAD_EXPIRY_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STATUS_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  [LeadStatus.NEW]: [
    LeadStatus.CONTACTED,
    LeadStatus.LOST,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.CONTACTED]: [
    LeadStatus.QUALIFIED,
    LeadStatus.LOST,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.QUALIFIED]: [LeadStatus.LOST, LeadStatus.ARCHIVED],
  [LeadStatus.WON]: [LeadStatus.ARCHIVED],
  [LeadStatus.LOST]: [LeadStatus.ARCHIVED],
  [LeadStatus.ARCHIVED]: [],
};

const LEAD_DETAIL_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  customer: {
    select: {
      id: true,
      code: true,
      fullName: true,
      title: true,
      firstName: true,
      middleName: true,
      lastName: true,
      phone: true,
      email: true,
    },
  },
  convertedCustomer: {
    select: {
      id: true,
      code: true,
      fullName: true,
      title: true,
      firstName: true,
      middleName: true,
      lastName: true,
      phone: true,
      email: true,
    },
  },
  currentOwner: {
    select: {
      id: true,
      fullName: true,
      title: true,
      firstName: true,
      middleName: true,
      lastName: true,
      email: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      fullName: true,
      title: true,
      firstName: true,
      middleName: true,
      lastName: true,
      email: true,
    },
  },
  ownerLogs: {
    orderBy: { assignedAt: 'desc' },
    take: 50,
    include: {
      assignedToUser: {
        select: {
          id: true,
          fullName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      assignedByUser: {
        select: {
          id: true,
          fullName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  },
} satisfies Prisma.LeadInclude;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomerService,
    private readonly branches: BranchesService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(user: AuthenticatedUser, dto: CreateLeadDto) {
    assertBranchAccess(user, dto.branchId);
    await this.branches.validateBranchActive(dto.branchId);

    let customerId = dto.customerId ?? null;
    if (!customerId && dto.phone) {
      const linked = await this.customers.findByPhoneOrEmail(
        dto.phone,
        dto.email ?? null,
      );
      customerId = linked?.id ?? null;
    } else if (!customerId && dto.email) {
      const linked = await this.customers.findByPhoneOrEmail(null, dto.email);
      customerId = linked?.id ?? null;
    } else if (customerId) {
      const exists = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true },
      });
      if (!exists) throw new BadRequestException('customerId does not exist');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEAD_EXPIRY_DAYS * MS_PER_DAY);
    const name = composeFullName(dto);

    const lead = await this.prisma.$transaction(async (tx) => {
      const code = await generateMonthlyCode(tx, 'LEAD', 'lead-code');
      const created = await tx.lead.create({
        data: {
          code,
          branchId: dto.branchId,
          customerId,
          name,
          title: dto.title,
          firstName: dto.firstName,
          middleName: dto.middleName,
          lastName: dto.lastName,
          phone: dto.phone,
          email: dto.email,
          lineId: dto.lineId,
          facebookName: dto.facebookName,
          source: dto.source,
          channel: dto.channel,
          notes: dto.notes,
          expiresAt,
          status: LeadStatus.NEW,
          createdByUserId: user.id,
        },
        include: LEAD_DETAIL_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: created.branchId,
        entityType: 'Lead',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          code: created.code,
          status: created.status,
          customerId: created.customerId,
          source: created.source,
          channel: created.channel,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
      });

      return created;
    });

    return lead;
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: ListLeadsQuery,
  ): Promise<PaginatedResult<Lead>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    if (query.branchId) assertBranchAccess(user, query.branchId);

    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      branchId: this.resolveBranchFilter(user, query.branchId),
      status: query.status,
      currentOwnerUserId: query.ownerId,
      channel: query.channel,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { lineId: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: query.dateFrom } : {}),
              ...(query.dateTo ? { lte: query.dateTo } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { id: true, code: true, name: true } },
          currentOwner: {
            select: {
              id: true,
              fullName: true,
              firstName: true,
              lastName: true,
            },
          },
          customer: {
            select: {
              id: true,
              code: true,
              fullName: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(user: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: LEAD_DETAIL_INCLUDE,
    });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    assertBranchAccess(user, lead.branchId);
    return lead;
  }

  // ───────────────────────── assign ─────────────────────────
  async assign(user: AuthenticatedUser, id: string, dto: AssignLeadDto) {
    const lead = await this.loadEditable(user, id);

    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assignedToUserId },
      select: { id: true, branchId: true, status: true },
    });
    if (!assignee) throw new BadRequestException('Assignee does not exist');
    if (assignee.status !== 'ACTIVE') {
      throw new BadRequestException('Assignee is not active');
    }
    // Branch-scoped roles can only assign to a teammate in the same branch.
    if (!isUnrestricted(user) && assignee.branchId !== lead.branchId) {
      throw new ForbiddenException('Assignee must belong to the lead branch');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.leadOwnerLog.updateMany({
        where: { leadId: id, endedAt: null },
        data: { endedAt: new Date() },
      });

      const updated = await tx.lead.update({
        where: { id },
        data: { currentOwnerUserId: dto.assignedToUserId },
        include: LEAD_DETAIL_INCLUDE,
      });

      await tx.leadOwnerLog.create({
        data: {
          leadId: id,
          assignedToUserId: dto.assignedToUserId,
          assignedByUserId: user.id,
          reason: dto.reason,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Lead',
        entityId: updated.id,
        action: AuditAction.ASSIGN,
        payload: {
          assignedToUserId: dto.assignedToUserId,
          previousOwnerUserId: lead.currentOwnerUserId,
          reason: dto.reason ?? null,
        },
      });

      return updated;
    });
  }

  // ───────────────────────── update status ─────────────────────────
  async updateStatus(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateLeadStatusDto,
  ) {
    const lead = await this.loadEditable(user, id);

    if (dto.status === LeadStatus.WON) {
      throw new BadRequestException(
        'WON status is set via /leads/:id/convert (requires customer)',
      );
    }
    if (dto.status === LeadStatus.ARCHIVED && !this.canArchive(user)) {
      throw new ForbiddenException(
        'Only ADMIN, BRANCH_MANAGER, or SUPER_BRANCH_MANAGER can archive leads',
      );
    }
    this.assertTransitionAllowed(lead.status, dto.status);

    return this.prisma.$transaction(async (tx) => {
      // Stamp `lastContactedAt` when the lead enters CONTACTED. We
      // intentionally don't reset it on later transitions — it's meant
      // to record the most recent CS touch, not the current state.
      const data: Prisma.LeadUpdateInput = { status: dto.status };
      if (dto.status === LeadStatus.CONTACTED) {
        data.lastContactedAt = new Date();
      }

      const updated = await tx.lead.update({
        where: { id },
        data,
        include: LEAD_DETAIL_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Lead',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: lead.status,
          to: dto.status,
          reason: dto.reason ?? null,
        },
      });

      return updated;
    });
  }

  // ───────────────────────── convert ─────────────────────────
  async convert(user: AuthenticatedUser, id: string, dto: ConvertLeadDto) {
    const lead = await this.loadEditable(user, id);
    if (lead.status === LeadStatus.WON || lead.status === LeadStatus.ARCHIVED) {
      throw new BadRequestException(
        `Cannot convert a lead in ${lead.status} state`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const linked = await tx.customer.findFirst({
        where: {
          deletedAt: null,
          OR: [
            ...(dto.phone ? [{ phone: dto.phone }] : []),
            ...(dto.email ? [{ email: dto.email }] : []),
          ],
        },
      });

      const customer = linked
        ? linked
        : await tx.customer.create({
            data: {
              code: await generateMonthlyCode(tx, 'CUST', 'customer-code'),
              fullName: composeFullName(dto),
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
              notes: dto.notes,
              currentBranchId: lead.branchId,
            },
          });

      const updated = await tx.lead.update({
        where: { id },
        // `customerId` (the loose link from creation) and
        // `convertedCustomerId` (the conversion result) point to the
        // same customer here, but we set both explicitly so the
        // conversion is queryable even when an existing customer was
        // already linked at creation time.
        data: {
          customerId: customer.id,
          convertedCustomerId: customer.id,
          status: LeadStatus.WON,
        },
        include: LEAD_DETAIL_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Lead',
        entityId: updated.id,
        action: AuditAction.COMPLETE,
        payload: {
          previousStatus: lead.status,
          newStatus: LeadStatus.WON,
          customerId: customer.id,
          customerLinked: !!linked,
        },
      });

      return { lead: updated, customer };
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private assertTransitionAllowed(from: LeadStatus, to: LeadStatus): void {
    if (from === to) return;
    const allowed = STATUS_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Invalid status transition: ${from} → ${to}`,
      );
    }
  }

  private canArchive(user: AuthenticatedUser): boolean {
    const allowed: ReadonlyArray<RoleCode> = [
      RoleCode.ADMIN,
      RoleCode.BRANCH_MANAGER,
      RoleCode.SUPER_BRANCH_MANAGER,
    ];
    return user.roles.some((r) => allowed.includes(r));
  }

  private async loadEditable(user: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        branchId: true,
        status: true,
        currentOwnerUserId: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    assertBranchAccess(user, lead.branchId);
    return lead;
  }

  private resolveBranchFilter(
    user: AuthenticatedUser,
    requested: string | undefined,
  ): string | undefined {
    if (isUnrestricted(user)) return requested;
    if (!user.branchId)
      throw new ForbiddenException('User has no branch assignment');
    return user.branchId;
  }
}
