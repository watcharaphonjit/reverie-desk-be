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
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundQueryDto } from './dto/refund-query.dto';
import { RefundsService } from './refunds.service';

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
  'CS',
] as const;
const APPROVE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
] as const;

@ApiTags('refunds')
@ApiBearerAuth('bearer')
@Controller('refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRefundDto) {
    return this.refunds.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: RefundQueryDto) {
    return this.refunds.findAll(user, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.refunds.findOne(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(...APPROVE_ROLES)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.refunds.approve(user, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(...APPROVE_ROLES)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return this.refunds.reject(user, id, body?.reason);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles(...APPROVE_ROLES)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { creditToWallet?: boolean } = {},
  ) {
    return this.refunds.complete(user, id, {
      creditToWallet: body?.creditToWallet,
    });
  }
}
