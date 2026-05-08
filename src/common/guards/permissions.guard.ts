import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PermissionCode } from '../authz/permission-codes';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';

/**
 * Allows a request through only if the authenticated user holds every
 * permission listed by the matching `@RequirePermission(...)` decorator.
 *
 * The `JwtStrategy.validate()` step populates `user.permissions` with the
 * user's effective permission set on each request, so this guard is a
 * pure in-memory `Set.has()` check (no DB round trip).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      PermissionCode[] | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    const granted = new Set(user.permissions);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required permission${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
