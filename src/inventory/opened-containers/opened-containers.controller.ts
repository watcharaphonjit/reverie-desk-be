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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CloseContainerDto } from './dto/close-container.dto';
import { OpenContainerDto } from './dto/open-container.dto';
import { OpenedContainerQueryDto } from './dto/opened-container-query.dto';
import { UseContainerDto } from './dto/use-container.dto';
import { OpenedContainersService } from './opened-containers.service';

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
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'DOCTOR',
] as const;

@Controller('opened-containers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class OpenedContainersController {
  constructor(private readonly containers: OpenedContainersService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenContainerDto,
  ) {
    return this.containers.open(user, dto);
  }

  @Post(':id/use')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  use(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UseContainerDto,
  ) {
    return this.containers.use(user, id, dto);
  }

  @Patch(':id/discard')
  @Roles(...WRITE_ROLES)
  discard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CloseContainerDto,
  ) {
    return this.containers.discard(user, id, dto);
  }

  @Patch(':id/expire')
  @Roles(...WRITE_ROLES)
  expire(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CloseContainerDto,
  ) {
    return this.containers.expire(user, id, dto);
  }

  @Get()
  findAll(@Query() query: OpenedContainerQueryDto) {
    return this.containers.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.containers.findOne(id);
  }
}
