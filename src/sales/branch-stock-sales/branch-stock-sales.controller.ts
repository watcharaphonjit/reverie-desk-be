import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BranchStockSalesService } from './branch-stock-sales.service';
import { ApproveRefundDto } from './dto/approve-refund.dto';
import { BranchStockSaleQueryDto } from './dto/branch-stock-sale-query.dto';
import { CancelBranchStockSaleDto } from './dto/cancel-branch-stock-sale.dto';
import { CreateBranchStockSaleDto } from './dto/create-branch-stock-sale.dto';
import { PayBranchStockSaleDto } from './dto/pay-branch-stock-sale.dto';
import { RefundBranchStockSaleDto } from './dto/refund-branch-stock-sale.dto';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'CS',
] as const;

const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CS',
] as const;

/** Approval is intentionally tighter — only managers can sign off on a refund. */
const REFUND_APPROVE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
] as const;

@ApiTags('branch-stock-sales')
@ApiBearerAuth('bearer')
@Controller('branch-stock-sales')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class BranchStockSalesController {
  constructor(private readonly sales: BranchStockSalesService) {}

  // Refund-approval lives under the same controller so we share auth wiring;
  // it must be declared *before* `:id`-prefixed routes so Nest's matcher
  // doesn't treat "refunds" as a sale id.
  @Patch('refunds/:id/approve')
  @Roles(...REFUND_APPROVE_ROLES)
  approveRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveRefundDto,
  ) {
    return this.sales.approveRefund(user, id, dto);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBranchStockSaleDto,
  ) {
    return this.sales.create(user, dto);
  }

  @Get()
  findAll(@Query() query: BranchStockSaleQueryDto) {
    return this.sales.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sales.findOne(id);
  }

  @Patch(':id/pay')
  @Roles(...WRITE_ROLES)
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayBranchStockSaleDto,
  ) {
    return this.sales.pay(user, id, dto);
  }

  @Patch(':id/complete')
  @Roles(...WRITE_ROLES)
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.sales.complete(user, id);
  }

  @Patch(':id/cancel')
  @Roles(...WRITE_ROLES)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelBranchStockSaleDto,
  ) {
    return this.sales.cancel(user, id, dto);
  }

  @Post(':id/refund')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...WRITE_ROLES)
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RefundBranchStockSaleDto,
  ) {
    return this.sales.requestRefund(user, id, dto);
  }
}
