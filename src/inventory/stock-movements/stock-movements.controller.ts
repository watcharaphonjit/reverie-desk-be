import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto';
import { StockMovementsService } from './stock-movements.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'DOCTOR',
  'CS',
] as const;

@ApiTags('inventory-stock-movements')
@ApiBearerAuth('bearer')
@Controller('stock-movements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class StockMovementsController {
  constructor(private readonly stockMovements: StockMovementsService) {}

  @Get()
  findAll(@Query() query: StockMovementQueryDto) {
    return this.stockMovements.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stockMovements.findOne(id);
  }
}
