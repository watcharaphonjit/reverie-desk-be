import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from '../authz/permission-codes';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restrict a route or controller to users that hold ALL of the given
 * permission codes.
 *
 * Permissions are checked AFTER `@Roles(...)` (when both guards are
 * registered) — the roles guard runs first because it's a cheaper check
 * against in-token data, and only successful role checks reach the
 * permission guard which has to consult the DB.
 *
 * @example
 *   @RequirePermission('REPORT_VIEW')
 *   @RequirePermission('AUDIT_VIEW', 'DASHBOARD_VIEW')
 */
export const RequirePermission = (...permissions: PermissionCode[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
