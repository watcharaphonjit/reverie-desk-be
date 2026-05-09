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
import { CancelStockTransferDto } from './dto/cancel-stock-transfer.dto';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { DispatchStockTransferDto } from './dto/dispatch-stock-transfer.dto';
import { ReceiveStockTransferDto } from './dto/receive-stock-transfer.dto';
import { StockTransferQueryDto } from './dto/stock-transfer-query.dto';
import { StockTransfersService } from './stock-transfers.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'CS',
  'DOCTOR',
] as const;

/** Anyone who can create or move a transfer through the workflow. */
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
] as const;

/**
 * Approve is intentionally tighter — branch managers can request, but
 * approving a cross-branch movement should sit with management/central stock.
 */
const APPROVE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
] as const;

@ApiTags('inventory-stock-transfers')
@ApiBearerAuth('bearer')
@Controller('stock-transfers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStockTransferDto,
  ) {
    return this.transfers.create(user, dto);
  }

  @Get()
  findAll(@Query() query: StockTransferQueryDto) {
    return this.transfers.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.transfers.findOne(id);
  }

  @Patch(':id/request')
  @Roles(...WRITE_ROLES)
  request(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transfers.request(user, id);
  }

  @Patch(':id/approve')
  @Roles(...APPROVE_ROLES)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transfers.approve(user, id);
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  dispatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DispatchStockTransferDto,
  ) {
    return this.transfers.dispatch(user, id, dto);
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReceiveStockTransferDto,
  ) {
    return this.transfers.receive(user, id, dto);
  }

  @Patch(':id/cancel')
  @Roles(...WRITE_ROLES)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelStockTransferDto,
  ) {
    return this.transfers.cancel(user, id, dto);
  }
}
