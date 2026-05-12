import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditLog, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  isUnrestricted,
  scopedBranchFilter,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditSummaryQueryDto } from './dto/audit-summary-query.dto';
import { UserActivityQueryDto } from './dto/user-activity-query.dto';

const AUDIT_INCLUDE = {
  actor: { select: { id: true, fullName: true, email: true } },
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.AuditLogInclude;

type AuditWithRelations = Prisma.AuditLogGetPayload<{
  include: typeof AUDIT_INCLUDE;
}>;

export interface UserActivityResult {
  user: { id: string; fullName: string; email: string };
  loginHistory: AuditWithRelations[];
  recentActions: AuditWithRelations[];
  latestActivity: AuditWithRelations | null;
  meta: { page: number; limit: number; total: number };
}

/**
 * Read-only access to `audit_logs`. The writer service lives in
 * `src/common/services/audit.service.ts` (different class) — this one is
 * the "report side" so the API split mirrors CQRS:
 *
 *   - `AuditService` (common): records new entries.
 *   - `AuditQueryService` (this file): exposes them via `/audit/*` routes.
 *
 * Branch scoping: BRANCH_MANAGER and below see only their own branch's
 * audit rows. Cross-branch roles (ADMIN, SUPER_BRANCH_MANAGER) see all.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────── search ─────────────────────────

  async search(
    user: AuthenticatedUser,
    query: AuditQueryDto,
  ): Promise<PaginatedResult<AuditWithRelations>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...this.dateRangeFilter(query.startDate, query.endDate),
    };

    // Branch scoping — branch-restricted roles see their own branch only.
    // The query may also explicitly request a branch via `branchId`; we
    // honor it but assert the caller has access first.
    if (query.branchId) {
      if (!isUnrestricted(user) && user.branchId !== query.branchId) {
        // Force an empty result rather than 403 — keeps the audit endpoint
        // safe for shared dashboards that filter aggressively.
        return {
          data: [],
          meta: { page: query.page ?? 1, limit: query.limit ?? 20, total: 0 },
        };
      }
      where.branchId = query.branchId;
    } else {
      const scoped = scopedBranchFilter(user);
      if (scoped !== undefined) where.branchId = scoped;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: AUDIT_INCLUDE,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async summary(user: AuthenticatedUser, query: AuditSummaryQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...this.dateRangeFilter(query.startDate, query.endDate),
    };

    if (query.branchId) {
      assertBranchAccess(user, query.branchId);
      where.branchId = query.branchId;
    } else {
      const scoped = scopedBranchFilter(user);
      if (scoped !== undefined) where.branchId = scoped;
    }

    const [totalEvents, bucketRows, recentEvents] =
      await this.prisma.$transaction([
        this.prisma.auditLog.count({ where }),
        this.prisma.auditLog.findMany({
          where,
          select: {
            action: true,
            entityType: true,
          },
        }),
        this.prisma.auditLog.findMany({
          where,
          include: AUDIT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: query.recentLimit ?? 8,
        }),
      ]);

    const byActionMap = new Map<AuditAction, number>();
    const byEntityMap = new Map<string, number>();
    for (const row of bucketRows) {
      byActionMap.set(row.action, (byActionMap.get(row.action) ?? 0) + 1);
      byEntityMap.set(
        row.entityType,
        (byEntityMap.get(row.entityType) ?? 0) + 1,
      );
    }

    return {
      summary: {
        totalEvents,
        totalLogins: byActionMap.get(AuditAction.LOGIN) ?? 0,
        totalLogouts: byActionMap.get(AuditAction.LOGOUT) ?? 0,
      },
      byAction: Array.from(byActionMap.entries()).map(([action, count]) => ({
        action,
        count,
      })),
      byEntity: Array.from(byEntityMap.entries())
        .map((row) => ({
          entityType: row[0],
          count: row[1],
        }))
        .sort((left, right) => right.count - left.count),
      recentEvents,
    };
  }

  // ───────────────────────── entity timeline ─────────────────────────

  async entityTimeline(
    user: AuthenticatedUser,
    entityType: string,
    entityId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginatedResult<AuditWithRelations>> {
    const where: Prisma.AuditLogWhereInput = { entityType, entityId };
    const scoped = scopedBranchFilter(user);
    if (scoped !== undefined) where.branchId = scoped;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        // Chronological for timelines: oldest first.
        orderBy: { createdAt: 'asc' },
        include: AUDIT_INCLUDE,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── user activity ─────────────────────────

  async userActivity(
    requester: AuthenticatedUser,
    targetUserId: string,
    query: UserActivityQueryDto,
  ): Promise<UserActivityResult> {
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        fullName: true,
        email: true,
        branchId: true,
      },
    });
    if (!targetUser) throw new NotFoundException('User not found');

    // Branch-scoped requesters can only inspect users in their own branch.
    if (
      !isUnrestricted(requester) &&
      targetUser.branchId !== requester.branchId
    ) {
      return {
        user: {
          id: targetUser.id,
          fullName: targetUser.fullName,
          email: targetUser.email,
        },
        loginHistory: [],
        recentActions: [],
        latestActivity: null,
        meta: { page: 1, limit: query.limit ?? 20, total: 0 },
      };
    }

    const dateFilter = this.dateRangeFilter(query.startDate, query.endDate);

    const baseWhere: Prisma.AuditLogWhereInput = {
      actorUserId: targetUserId,
      ...dateFilter,
    };
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [loginHistory, recentActions, latest, total] =
      await this.prisma.$transaction([
        this.prisma.auditLog.findMany({
          where: {
            ...baseWhere,
            action: { in: [AuditAction.LOGIN, AuditAction.LOGOUT] },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: AUDIT_INCLUDE,
        }),
        this.prisma.auditLog.findMany({
          where: {
            ...baseWhere,
            action: { notIn: [AuditAction.LOGIN, AuditAction.LOGOUT] },
          },
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: AUDIT_INCLUDE,
        }),
        this.prisma.auditLog.findFirst({
          where: baseWhere,
          orderBy: { createdAt: 'desc' },
          include: AUDIT_INCLUDE,
        }),
        this.prisma.auditLog.count({
          where: {
            ...baseWhere,
            action: { notIn: [AuditAction.LOGIN, AuditAction.LOGOUT] },
          },
        }),
      ]);

    return {
      user: {
        id: targetUser.id,
        fullName: targetUser.fullName,
        email: targetUser.email,
      },
      loginHistory,
      recentActions,
      latestActivity: latest,
      meta: { page, limit, total },
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  private dateRangeFilter(
    startDate?: string,
    endDate?: string,
  ): Pick<Prisma.AuditLogWhereInput, 'createdAt'> {
    if (!startDate && !endDate) return {};
    const range: Prisma.DateTimeFilter = {};
    if (startDate) range.gte = new Date(startDate);
    if (endDate) range.lt = new Date(endDate);
    return { createdAt: range };
  }
}

export type { AuditLog, AuditWithRelations };
