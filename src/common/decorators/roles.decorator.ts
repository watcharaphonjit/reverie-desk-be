import { SetMetadata } from '@nestjs/common';
import { RoleCode } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route or controller to users that hold at least one of the given roles.
 *
 * @example
 *   @Roles('ADMIN')
 *   @Roles('ADMIN', 'BRANCH_MANAGER')
 */
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);
