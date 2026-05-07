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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CompleteServiceEventDto } from './dto/complete-service-event.dto';
import { ConsumeStockDto } from './dto/consume-stock.dto';
import { CreateServiceEventDto } from './dto/create-service-event.dto';
import { ServiceEventQueryDto } from './dto/service-event-query.dto';
import { ServiceEventsService } from './service-events.service';

const READ_ROLES = ['ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER', 'DOCTOR', 'CS'] as const;
const WRITE_ROLES = ['ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER', 'DOCTOR'] as const;

@Controller('service-events')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class ServiceEventsController {
  constructor(private readonly serviceEvents: ServiceEventsService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateServiceEventDto,
  ) {
    return this.serviceEvents.create(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ServiceEventQueryDto,
  ) {
    return this.serviceEvents.findAll(user, query);
  }

  @Get('customer/:customerId')
  findByCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
    @Query() query: ServiceEventQueryDto,
  ) {
    return this.serviceEvents.findByCustomer(user, customerId, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.serviceEvents.findOne(user, id);
  }

  @Post(':id/consume-stock')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  consumeStock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConsumeStockDto,
  ) {
    return this.serviceEvents.consumeStock(user, id, dto);
  }

  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CompleteServiceEventDto,
  ) {
    return this.serviceEvents.complete(user, id, dto);
  }
}
