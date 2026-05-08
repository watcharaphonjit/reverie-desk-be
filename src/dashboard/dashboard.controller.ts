import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CacheService } from '../cache/cache.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { DashboardService } from './dashboard.service';

/**
 * Dashboard endpoints are read-heavy and tolerant of staleness — exactly
 * the workload that benefits from a short Redis TTL. We cache per
 * (endpoint, user/branch) for `dashboardTtlSeconds` (default 30s); writes
 * elsewhere don't need to invalidate because the TTL is short enough that
 * a 30-second lag on an executive card is acceptable.
 */
@ApiTags('dashboard')
@ApiBearerAuth('bearer')
@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('DASHBOARD_VIEW')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly cache: CacheService,
  ) {}

  @Get('executive')
  executive(@CurrentUser() user: AuthenticatedUser) {
    return this.cache.wrap(
      `dash:executive:${user.id}:${user.branchId ?? 'global'}`,
      this.cache.dashboardTtl(),
      () => this.dashboard.executive(user),
    );
  }

  @Get('branch/:branchId')
  branch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchId') branchId: string,
  ) {
    return this.cache.wrap(
      `dash:branch:${branchId}:${user.id}`,
      this.cache.dashboardTtl(),
      () => this.dashboard.branch(user, branchId),
    );
  }

  @Get('doctor/:userId')
  doctor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
  ) {
    return this.cache.wrap(
      `dash:doctor:${userId}:${user.id}`,
      this.cache.dashboardTtl(),
      () => this.dashboard.doctor(user, userId),
    );
  }

  @Get('telesales/:userId')
  telesales(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
  ) {
    return this.cache.wrap(
      `dash:telesales:${userId}:${user.id}`,
      this.cache.dashboardTtl(),
      () => this.dashboard.telesales(user, userId),
    );
  }
}
