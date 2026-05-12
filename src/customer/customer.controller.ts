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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CustomerService } from './customer.service';
import { ChangeBranchDto } from './dto/change-branch.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('customers')
@ApiBearerAuth('bearer')
@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  @Roles('ADMIN', 'CS', 'TELESALES', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customerService.create(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CustomerQueryDto,
  ) {
    return this.customerService.findAll(user, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customerService.findOne(user, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'CS', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customerService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customerService.remove(user, id);
  }

  @Post(':id/change-branch')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  changeBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeBranchDto,
  ) {
    return this.customerService.changeBranch(user, id, dto.branchId);
  }
}
