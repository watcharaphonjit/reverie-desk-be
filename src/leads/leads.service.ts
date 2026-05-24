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
import { CreateLeadInteractionDto } from './dto/create-lead-interaction.dto';
import { ListLeadsQuery } from './dto/list-leads.query';
import { LinkLeadCustomerDto } from './dto/link-lead-customer.dto';
import { UpdateLeadInteractionDto } from './dto/update-lead-interaction.dto';
import { UpdateLeadStatusDto } from './dto/update-status.dto';

/** A lead automatically expires this many days after creation. */
const LEAD_EXPIRY_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STATUS_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  [LeadStatus.NEW]: [LeadStatus.CONTACTED],
  [LeadStatus.CONTACTED]: [LeadStatus.FOLLOW_UP],
  [LeadStatus.FOLLOW_UP]: [LeadStatus.CONTACTED, LeadStatus.QUALIFIED],
  [LeadStatus.QUALIFIED]: [LeadStatus.LOST],
  [LeadStatus.WON]: [LeadStatus.ARCHIVED],
  [LeadStatus.LOST]: [LeadStatus.ARCHIVED],
  [LeadStatus.ARCHIVED]: [],
};

const LEAD_INTERACTION_INCLUDE = {
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
} satisfies Prisma.LeadInteractionInclude;

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
  interactions: {
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: LEAD_INTERACTION_INCLUDE,
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

    const phone = this.validatePhoneRequired(dto.phone);

    let customerId = dto.customerId ?? null;
    if (!customerId && phone) {
      const linked = await this.customers.findByPhoneOrEmail(
        phone,
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

    const ownerUserId = dto.ownerUserId ?? user.id;
    if (ownerUserId !== user.id) {
      const owner = await this.prisma.user.findUnique({
        where: { id: ownerUserId },
        select: { id: true, branchId: true, status: true },
      });
      if (!owner) throw new BadRequestException('ownerUserId does not exist');
      if (owner.status !== 'ACTIVE') {
        throw new BadRequestException('Owner user is not active');
      }
      if (!isUnrestricted(user) && owner.branchId !== dto.branchId) {
        throw new ForbiddenException('Owner must belong to the lead branch');
      }
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
          phone,
          email: dto.email,
          lineId: dto.lineId,
          facebookName: dto.facebookName,
          source: dto.source,
          channel: dto.channel,
          notes: dto.notes,
          orgSalesAmount: dto.orgSalesAmount,
          adsSalesAmount: dto.adsSalesAmount,
          procedureTypes: dto.procedureTypes ?? [],
          depositStatus: dto.depositStatus,
          appointmentDate: dto.appointmentDate,
          page: dto.page,
          adsLink: dto.adsLink,
          expiresAt,
          status: LeadStatus.NEW,
          currentOwnerUserId: ownerUserId,
          createdByUserId: user.id,
        },
        include: LEAD_DETAIL_INCLUDE,
      });

      await tx.leadOwnerLog.create({
        data: {
          leadId: created.id,
          assignedToUserId: ownerUserId,
          assignedByUserId: user.id,
          reason: 'Initial owner on create',
        },
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
          ownerUserId,
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

    const ownerId =
      query.ownerId ?? (this.isTelesalesOnly(user) ? user.id : undefined);

    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      branchId: this.resolveBranchFilter(user, query.branchId),
      status: query.status,
      currentOwnerUserId: ownerId,
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
    this.assertLeadOwnership(user, lead);
    return lead;
  }

  async listInteractions(user: AuthenticatedUser, id: string) {
    const lead = await this.requireLeadAccess(user, id);
    return this.prisma.leadInteraction.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
      include: LEAD_INTERACTION_INCLUDE,
    });
  }

  async createInteraction(
    user: AuthenticatedUser,
    leadId: string,
    dto: CreateLeadInteractionDto,
  ) {
    const lead = await this.requireLeadAccess(user, leadId);
    const createdAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      const interaction = await tx.leadInteraction.create({
        data: {
          leadId: lead.id,
          type: dto.type,
          note: dto.note.trim(),
          outcome: dto.outcome?.trim() || null,
          nextActionAt: dto.nextActionAt ?? null,
          createdByUserId: user.id,
          createdAt,
        },
        include: LEAD_INTERACTION_INCLUDE,
      });

      await tx.lead.update({
        where: { id: lead.id },
        data: { lastContactedAt: createdAt },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: lead.branchId,
        entityType: 'LeadInteraction',
        entityId: interaction.id,
        action: AuditAction.CREATE,
        payload: {
          leadId: lead.id,
          type: interaction.type,
          outcome: interaction.outcome,
          nextActionAt: interaction.nextActionAt?.toISOString() ?? null,
        },
      });

      return interaction;
    });
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

      await tx.leadOwnerLog.create({
        data: {
          leadId: id,
          assignedToUserId: dto.assignedToUserId,
          assignedByUserId: user.id,
          reason: dto.reason,
        },
      });

      const updated = await tx.lead.update({
        where: { id },
        data: { currentOwnerUserId: dto.assignedToUserId },
        include: LEAD_DETAIL_INCLUDE,
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
    const lead = await this.loadEditable(user, id, {
      allowArchiveWhenExpired: dto.status === LeadStatus.ARCHIVED,
    });

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
    const skipTransitionCheck =
      dto.status === LeadStatus.ARCHIVED &&
      this.canArchive(user) &&
      this.isExpired(lead);
    if (!skipTransitionCheck) {
      this.assertTransitionAllowed(lead.status, dto.status);
    }

    return this.prisma.$transaction(async (tx) => {
      // Stamp `lastContactedAt` when the lead enters CONTACTED. We
      // intentionally don't reset it on later transitions — it's meant
      // to record the most recent CS touch, not the current state.
      const data: Prisma.LeadUpdateInput = { status: dto.status };
      if (
        dto.status === LeadStatus.CONTACTED ||
        dto.status === LeadStatus.FOLLOW_UP
      ) {
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
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        status: true,
        expiresAt: true,
        title: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        email: true,
        lineId: true,
        notes: true,
        currentOwnerUserId: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    assertBranchAccess(user, lead.branchId);
    this.assertLeadOwnership(user, lead);
    this.assertNotExpired(lead);
    if (lead.status !== LeadStatus.QUALIFIED) {
      throw new BadRequestException(
        `Only QUALIFIED leads can be converted (current: ${lead.status})`,
      );
    }

    const firstName = dto.firstName ?? lead.firstName;
    const lastName = dto.lastName ?? lead.lastName;
    if (!firstName || !lastName) {
      throw new BadRequestException(
        'Lead conversion requires firstName and lastName on the lead or payload',
      );
    }

    const customerDraft = {
      title: dto.title ?? lead.title ?? undefined,
      firstName,
      middleName: dto.middleName ?? lead.middleName ?? undefined,
      lastName,
      nickname: dto.nickname,
      phone: dto.phone ?? lead.phone ?? undefined,
      email: dto.email ?? lead.email ?? undefined,
      lineId: dto.lineId ?? lead.lineId ?? undefined,
      gender: dto.gender,
      birthdate: dto.birthdate ?? null,
      notes: dto.notes ?? lead.notes ?? undefined,
    };

    const existingCustomer =
      (lead.customerId
        ? await this.prisma.customer.findUnique({
            where: { id: lead.customerId },
          })
        : null) ??
      (customerDraft.phone || customerDraft.email
        ? await this.prisma.customer.findFirst({
            where: {
              deletedAt: null,
              OR: [
                ...(customerDraft.phone
                  ? [{ phone: customerDraft.phone }]
                  : []),
                ...(customerDraft.email
                  ? [{ email: customerDraft.email }]
                  : []),
              ],
            },
          })
        : null);

    if (!existingCustomer && !dto.birthdate) {
      throw new BadRequestException(
        'birthdate is required when creating a new customer',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const linked =
        existingCustomer ??
        (lead.customerId
          ? await tx.customer.findUnique({
              where: { id: lead.customerId },
            })
          : null) ??
        (customerDraft.phone || customerDraft.email
          ? await tx.customer.findFirst({
              where: {
                deletedAt: null,
                OR: [
                  ...(customerDraft.phone
                    ? [{ phone: customerDraft.phone }]
                    : []),
                  ...(customerDraft.email
                    ? [{ email: customerDraft.email }]
                    : []),
                ],
              },
            })
          : null);

      const customer = linked
        ? linked
        : await tx.customer.create({
            data: {
              code: await generateMonthlyCode(tx, 'CUST', 'customer-code'),
              fullName: composeFullName(customerDraft),
              title: customerDraft.title,
              firstName: customerDraft.firstName,
              middleName: customerDraft.middleName,
              lastName: customerDraft.lastName,
              nickname: customerDraft.nickname,
              phone: customerDraft.phone,
              email: customerDraft.email,
              lineId: customerDraft.lineId,
              gender: customerDraft.gender,
              birthdate: customerDraft.birthdate,
              notes: customerDraft.notes,
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

      return { lead: updated, customer, linkedExisting: !!linked };
    });
  }

  async linkCustomer(
    user: AuthenticatedUser,
    id: string,
    dto: LinkLeadCustomerDto,
  ) {
    const lead = await this.loadEditable(user, id);
    if (lead.status === LeadStatus.WON || lead.status === LeadStatus.ARCHIVED) {
      throw new BadRequestException('Cannot link customer to a closed lead');
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, deletedAt: true, currentBranchId: true },
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException('Customer not found');
    }
    if (
      customer.currentBranchId &&
      customer.currentBranchId !== lead.branchId
    ) {
      throw new BadRequestException(
        'Customer branch does not match lead branch',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: { customerId: dto.customerId },
        include: LEAD_DETAIL_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Lead',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'customerId',
          customerId: dto.customerId,
        },
      });

      return updated;
    });
  }

  async updateInteraction(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateLeadInteractionDto,
  ) {
    const existing = await this.loadInteraction(user, id);
    const data: Prisma.LeadInteractionUpdateInput = {};

    if (dto.type !== undefined) data.type = dto.type;
    if (dto.note !== undefined) data.note = dto.note.trim();
    if (dto.outcome !== undefined) data.outcome = dto.outcome?.trim() || null;
    if (dto.nextActionAt !== undefined) data.nextActionAt = dto.nextActionAt;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'At least one interaction field is required',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.leadInteraction.update({
        where: { id },
        data,
        include: LEAD_INTERACTION_INCLUDE,
      });

      await tx.lead.update({
        where: { id: existing.lead.id },
        data: { lastContactedAt: new Date() },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: existing.lead.branchId,
        entityType: 'LeadInteraction',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          leadId: existing.lead.id,
          changes: {
            ...(dto.type !== undefined
              ? { type: { from: existing.type, to: dto.type } }
              : {}),
            ...(dto.note !== undefined
              ? { note: { from: existing.note, to: dto.note.trim() } }
              : {}),
            ...(dto.outcome !== undefined
              ? {
                  outcome: {
                    from: existing.outcome,
                    to: dto.outcome?.trim() || null,
                  },
                }
              : {}),
            ...(dto.nextActionAt !== undefined
              ? {
                  nextActionAt: {
                    from: existing.nextActionAt?.toISOString() ?? null,
                    to: dto.nextActionAt?.toISOString() ?? null,
                  },
                }
              : {}),
          },
        },
      });

      return updated;
    });
  }

  async deleteInteraction(user: AuthenticatedUser, id: string) {
    const existing = await this.loadInteraction(user, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.leadInteraction.delete({ where: { id } });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: existing.lead.branchId,
        entityType: 'LeadInteraction',
        entityId: existing.id,
        action: AuditAction.DELETE,
        payload: {
          leadId: existing.lead.id,
          type: existing.type,
          createdByUserId: existing.createdByUserId,
        },
      });
    });

    return { id, deleted: true };
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

  private async loadEditable(
    user: AuthenticatedUser,
    id: string,
    opts?: { allowArchiveWhenExpired?: boolean },
  ) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        branchId: true,
        status: true,
        currentOwnerUserId: true,
        expiresAt: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    assertBranchAccess(user, lead.branchId);
    this.assertLeadOwnership(user, lead);
    this.assertNotExpired(lead, opts?.allowArchiveWhenExpired ?? false);
    return lead;
  }

  private async requireLeadAccess(user: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        branchId: true,
        deletedAt: true,
        currentOwnerUserId: true,
        expiresAt: true,
      },
    });
    if (!lead || lead.deletedAt) throw new NotFoundException('Lead not found');
    assertBranchAccess(user, lead.branchId);
    this.assertLeadOwnership(user, lead);
    this.assertNotExpired(lead);
    return lead;
  }

  private validatePhoneRequired(phone: string): string {
    const trimmed = phone.trim();
    if (!trimmed) throw new BadRequestException('Phone is required');
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 12) {
      throw new BadRequestException('Phone must be 10–12 digits');
    }
    return trimmed;
  }

  private isExpired(lead: { expiresAt: Date | null }): boolean {
    return lead.expiresAt != null && lead.expiresAt.getTime() < Date.now();
  }

  private isTelesalesOnly(user: AuthenticatedUser): boolean {
    return (
      user.roles.includes(RoleCode.TELESALES) &&
      !user.roles.some((r) =>
        (
          [
            RoleCode.ADMIN,
            RoleCode.SUPER_BRANCH_MANAGER,
            RoleCode.BRANCH_MANAGER,
            RoleCode.CS,
          ] as RoleCode[]
        ).includes(r),
      )
    );
  }

  private assertNotExpired(
    lead: { expiresAt: Date | null },
    allowArchive = false,
  ): void {
    if (!this.isExpired(lead)) return;
    if (allowArchive) return;
    throw new BadRequestException('Lead has expired and is locked for editing');
  }

  private assertLeadOwnership(
    user: AuthenticatedUser,
    lead: { currentOwnerUserId: string | null },
  ): void {
    if (!this.isTelesalesOnly(user)) return;
    if (lead.currentOwnerUserId !== user.id) {
      throw new ForbiddenException('You do not own this lead');
    }
  }

  private async loadInteraction(user: AuthenticatedUser, id: string) {
    const interaction = await this.prisma.leadInteraction.findUnique({
      where: { id },
      include: {
        lead: {
          select: {
            id: true,
            branchId: true,
          },
        },
      },
    });
    if (!interaction) {
      throw new NotFoundException('Lead interaction not found');
    }
    assertBranchAccess(user, interaction.lead.branchId);
    return interaction;
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
