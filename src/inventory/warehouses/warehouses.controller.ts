import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WarehouseQueryDto } from './dto/warehouse-query.dto';
import { WarehousesService } from './warehouses.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'DOCTOR',
  'CS',
] as const;

@ApiTags('inventory-warehouses')
@ApiBearerAuth('bearer')
@Controller('warehouses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  findAll(@Query() query: WarehouseQueryDto) {
    return this.warehouses.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.warehouses.findOne(id);
  }
}
