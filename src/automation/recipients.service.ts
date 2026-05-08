import { Injectable } from '@nestjs/common';
import { RoleCode, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Rule helper — resolves "the right person to notify" lookups against
 * the role + branch graph.
 *
 * Cached briefly (LRU is overkill for the cardinalities here, so we
 * just memoize per-call inside services). The DB queries themselves are
 * cheap and indexed, so we don't pre-cache here.
 */
@Injectable()
export class RecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active users holding any of the given roles, optionally scoped to a
   * branch. Roles are matched against `UserRole.role.code`. Branch
   * filter applies to `UserRole.branchId` so a user can hold the role
   * either branch-wide or branch-scoped.
   */
  async usersByRoles(
    codes: RoleCode[],
    branchId?: string | null,
  ): Promise<string[]> {
    if (codes.length === 0) return [];
    const rows = await this.prisma.userRole.findMany({
      where: {
        role: { code: { in: codes } },
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
        user: { status: UserStatus.ACTIVE },
      },
      select: { userId: true },
    });
    return Array.from(new Set(rows.map((r) => r.userId)));
  }

  async branchManagers(branchId: string): Promise<string[]> {
    return this.usersByRoles(
      [RoleCode.BRANCH_MANAGER, RoleCode.SUPER_BRANCH_MANAGER, RoleCode.ADMIN],
      branchId,
    );
  }

  async centralStockHub(): Promise<string[]> {
    return this.usersByRoles([
      RoleCode.CENTRAL_STOCK_HUB,
      RoleCode.SUPER_BRANCH_MANAGER,
      RoleCode.ADMIN,
    ]);
  }
}
