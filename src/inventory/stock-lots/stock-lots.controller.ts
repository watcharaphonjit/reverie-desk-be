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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdjustStockLotDto } from './dto/adjust-stock-lot.dto';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { StockLotActionDto } from './dto/stock-lot-action.dto';
import {
  ExpiringStockLotQueryDto,
  StockLotQueryDto,
} from './dto/stock-lot-query.dto';
import { StockLotsService } from './stock-lots.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'CS',
  'DOCTOR',
] as const;
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
] as const;
const ACTION_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
] as const;

@ApiTags('inventory-stock-lots')
@ApiBearerAuth('bearer')
@Controller('stock-lots')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class StockLotsController {
  constructor(private readonly stockLots: StockLotsService) {}

  @Post('receive')
  @Roles(...WRITE_ROLES)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReceiveStockDto,
  ) {
    return this.stockLots.receive(user, dto);
  }

  @Get()
  findAll(@Query() query: StockLotQueryDto) {
    return this.stockLots.findAll(query);
  }

  /**
   * MUST be declared before `:id` so Nest's path matcher resolves
   * `/stock-lots/expiring` to this handler instead of treating `expiring` as an id.
   */
  @Get('expiring')
  findExpiring(@Query() query: ExpiringStockLotQueryDto) {
    return this.stockLots.findExpiring(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stockLots.findOne(id);
  }

  @Post(':id/adjust')
  @Roles(...ACTION_ROLES)
  adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdjustStockLotDto,
  ) {
    return this.stockLots.adjust(user, id, dto);
  }

  @Patch(':id/quarantine')
  @Roles(...ACTION_ROLES)
  quarantine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: StockLotActionDto,
  ) {
    return this.stockLots.quarantine(user, id, dto.reason);
  }

  @Patch(':id/dispose')
  @Roles(...ACTION_ROLES)
  dispose(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: StockLotActionDto,
  ) {
    return this.stockLots.dispose(user, id, dto.reason);
  }
}
