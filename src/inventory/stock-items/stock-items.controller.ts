import {
  Body,
  Controller,
  Delete,
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
import { CreateStockItemDto } from './dto/create-stock-item.dto';
import { StockItemQueryDto } from './dto/stock-item-query.dto';
import { UpdateStockItemDto } from './dto/update-stock-item.dto';
import { StockItemsService } from './stock-items.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'DOCTOR',
  'CS',
] as const;
const WRITE_ROLES = ['ADMIN', 'SUPER_BRANCH_MANAGER', 'CENTRAL_STOCK_HUB'] as const;

@ApiTags('inventory-stock-items')
@ApiBearerAuth('bearer')
@Controller('stock-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class StockItemsController {
  constructor(private readonly stockItems: StockItemsService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStockItemDto,
  ) {
    return this.stockItems.create(user, dto);
  }

  @Get()
  findAll(@Query() query: StockItemQueryDto) {
    return this.stockItems.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stockItems.findOne(id);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateStockItemDto,
  ) {
    return this.stockItems.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.stockItems.remove(user, id);
  }
}
