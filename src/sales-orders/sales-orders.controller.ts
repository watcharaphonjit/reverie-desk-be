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
import {
  CancelSalesOrderDto,
  ConfirmSalesOrderDto,
} from './dto/confirm-sales-order.dto';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { SalesOrderQueryDto } from './dto/sales-order-query.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { SalesOrdersService } from './sales-orders.service';

@Controller('sales-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER', 'CS')
export class SalesOrdersController {
  constructor(private readonly salesOrders: SalesOrdersService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.salesOrders.create(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SalesOrderQueryDto,
  ) {
    return this.salesOrders.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.salesOrders.findOne(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSalesOrderDto,
  ) {
    return this.salesOrders.update(user, id, dto);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmSalesOrderDto,
  ) {
    return this.salesOrders.confirm(user, id, dto.note);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelSalesOrderDto,
  ) {
    return this.salesOrders.cancel(user, id, dto.reason);
  }
}
