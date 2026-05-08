import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CommissionsService } from './commissions.service';
import { CommissionQueryDto } from './dto/commission-query.dto';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CS',
  'TELESALES',
] as const;
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
] as const;

@ApiTags('commissions')
@ApiBearerAuth('bearer')
@Controller('commissions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Post('evaluate/:salesOrderId')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  evaluate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salesOrderId') salesOrderId: string,
  ) {
    return this.commissions.evaluateOrder(user, salesOrderId);
  }

  @Get()
  list(@Query() query: CommissionQueryDto) {
    return this.commissions.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.commissions.findOne(id);
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { note?: string } = {},
  ) {
    return this.commissions.lock(user, id, body?.note ?? null);
  }

  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { note?: string } = {},
  ) {
    return this.commissions.pay(user, id, body?.note ?? null);
  }
}
