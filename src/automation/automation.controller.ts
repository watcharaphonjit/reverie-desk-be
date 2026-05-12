import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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
import { AutomationService } from './automation.service';
import { AutomationRunsQueryDto } from './dto/automation-runs-query.dto';
import { ToggleRuleDto } from './dto/toggle-rule.dto';

@ApiTags('automation')
@ApiBearerAuth('bearer')
@Controller('automation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('AUTOMATION_MANAGE')
@Throttle({
  default: {
    ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
    limit: Number(process.env.THROTTLE_ADMIN_LIMIT ?? 50),
  },
})
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('rules')
  list() {
    return this.automation.list();
  }

  @Get('runs')
  runs(@Query() query: AutomationRunsQueryDto) {
    return this.automation.listRuns(query);
  }

  @Post('run/:code')
  run(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.automation.run(code.toUpperCase(), user);
  }

  @Patch('rules/:code')
  async setEnabled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: ToggleRuleDto,
  ) {
    await this.automation.setEnabled(user, code.toUpperCase(), dto.enabled);
    return { code: code.toUpperCase(), enabled: dto.enabled };
  }
}
