import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AssignUserBranchDto } from './dto/assign-user-branch.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth('bearer')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get()
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findAll(user);
  }

  @Get('by-branch/:branchId')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  findByBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchId') branchId: string,
  ) {
    return this.usersService.findByBranch(user, branchId);
  }

  @Get(':id')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.findOne(user, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(user, id, dto);
  }

  @Patch(':id/assign-branch')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  assignBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignUserBranchDto,
  ) {
    return this.usersService.assignBranch(user, id, dto.branchId);
  }

  @Patch(':id/unassign-branch')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  unassignBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.usersService.unassignBranch(user, id);
  }
}
