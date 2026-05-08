import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ExpirySweepService } from './expiry-sweep.service';

/**
 * Manual trigger for the expiry-sweep job. Use sparingly; the cron handler
 * runs automatically every day at 03:00. Restricted to admin-tier roles.
 */
@ApiTags('inventory-expiry-sweep')
@ApiBearerAuth('bearer')
@Controller('admin/expiry-sweep')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'CENTRAL_STOCK_HUB')
export class ExpirySweepController {
  constructor(private readonly sweep: ExpirySweepService) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  run(@CurrentUser() user: AuthenticatedUser) {
    return this.sweep.runSweep(user.id);
  }
}
