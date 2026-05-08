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
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitQueryDto } from './dto/unit-query.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { UnitsService } from './units.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'DOCTOR',
  'CS',
] as const;
const WRITE_ROLES = ['ADMIN', 'SUPER_BRANCH_MANAGER', 'CENTRAL_STOCK_HUB'] as const;

@ApiTags('inventory-units')
@ApiBearerAuth('bearer')
@Controller('units')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUnitDto) {
    return this.units.create(user, dto);
  }

  @Get()
  findAll(@Query() query: UnitQueryDto) {
    return this.units.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.units.findOne(id);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.units.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.units.remove(user, id);
  }
}
