import {
  Body,
  Controller,
  Get,
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
import { BranchesService } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { ListBranchesQuery } from './dto/list-branches.query';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Controller('branches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Post()
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBranchDto) {
    return this.branchesService.create(user, dto);
  }

  @Get()
  findAll(@Query() query: ListBranchesQuery) {
    return this.branchesService.findAll(query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.branchesService.findOne(user, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchesService.update(user, id, dto);
  }

  @Patch(':id/activate')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  activate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.branchesService.activate(user, id);
  }

  @Patch(':id/deactivate')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER')
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.branchesService.deactivate(user, id);
  }
}
