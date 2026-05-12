import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AuditQueryService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditSummaryQueryDto } from './dto/audit-summary-query.dto';
import { UserActivityQueryDto } from './dto/user-activity-query.dto';

@ApiTags('audit')
@ApiBearerAuth('bearer')
@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('AUDIT_VIEW')
@Throttle({
  default: {
    ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
    limit: Number(process.env.THROTTLE_ADMIN_LIMIT ?? 50),
  },
})
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditQueryDto,
  ) {
    return this.audit.search(user, query);
  }

  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditSummaryQueryDto,
  ) {
    return this.audit.summary(user, query);
  }

  @Get('entity/:entityType/:entityId')
  entityTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.audit.entityTimeline(
      user,
      entityType,
      entityId,
      page ?? 1,
      Math.min(limit ?? 50, 200),
    );
  }

  @Get('user/:userId')
  userActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: UserActivityQueryDto,
  ) {
    return this.audit.userActivity(user, userId, query);
  }
}
