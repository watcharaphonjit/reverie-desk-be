import { ForbiddenException } from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

const UNRESTRICTED_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  RoleCode.ADMIN,
  RoleCode.SUPER_BRANCH_MANAGER,
]);

export const isUnrestricted = (user: AuthenticatedUser): boolean =>
  user.roles.some((role) => UNRESTRICTED_ROLES.has(role));

/**
 * Ensure the caller can act on a record from `targetBranchId`.
 * Throws ForbiddenException for branch-scoped roles whose branchId mismatches.
 */
export function assertBranchAccess(
  user: AuthenticatedUser,
  targetBranchId: string | null | undefined,
): void {
  if (isUnrestricted(user)) return;
  if (!user.branchId) {
    throw new ForbiddenException('User has no branch assignment');
  }
  if (targetBranchId && user.branchId !== targetBranchId) {
    throw new ForbiddenException('Branch access denied');
  }
}

/**
 * Returns the branchId filter to inject into list queries:
 *   - undefined for unrestricted roles (no filter)
 *   - the user's own branchId for branch-scoped roles
 *
 * Pair with the requested filter via:
 *   `branchId: requestedBranch ?? scopedBranchFilter(user)`
 * but if the caller asked for a branch they don't own, throw via assertBranchAccess.
 */
export function scopedBranchFilter(
  user: AuthenticatedUser,
): string | undefined {
  return isUnrestricted(user) ? undefined : (user.branchId ?? '__none__');
}
