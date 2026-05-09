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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AssignLeadDto } from './dto/assign-lead.dto';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQuery } from './dto/list-leads.query';
import { UpdateLeadStatusDto } from './dto/update-status.dto';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@ApiBearerAuth('bearer')
@Controller('leads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  @Roles('ADMIN', 'TELESALES', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLeadDto) {
    return this.leadsService.create(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadsQuery,
  ) {
    return this.leadsService.findAll(user, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.findOne(user, id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'TELESALES', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignLeadDto,
  ) {
    return this.leadsService.assign(user, id, dto);
  }

  @Patch(':id/status')
  @Roles('ADMIN', 'TELESALES', 'CS', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
  ) {
    return this.leadsService.updateStatus(user, id, dto);
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'CS', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER')
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
  ) {
    return this.leadsService.convert(user, id, dto);
  }
}
