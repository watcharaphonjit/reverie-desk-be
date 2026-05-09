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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CommissionRulesService } from './commission-rules.service';
import { BulkUpsertCommissionRulesDto } from './dto/bulk-upsert-commission-rules.dto';
import { CalculateCommissionDto } from './dto/calculate-commission.dto';
import { CommissionRuleQueryDto } from './dto/commission-rule-query.dto';
import { CreateCommissionRuleDto } from './dto/create-commission-rule.dto';
import { UpdateCommissionRuleDto } from './dto/update-commission-rule.dto';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CS',
] as const;
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
] as const;

@ApiTags('commission-rules')
@ApiBearerAuth('bearer')
@Controller('commission-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class CommissionRulesController {
  constructor(private readonly rules: CommissionRulesService) {}

  @Get()
  @ApiOperation({ summary: 'List commission tier rules with filters' })
  findAll(@Query() query: CommissionRuleQueryDto) {
    return this.rules.findAll(query);
  }

  /**
   * Create a single tier row. For replacing an entire ladder atomically
   * use `POST /commission-rules/bulk-upsert` instead.
   */
  @Post()
  @Roles(...WRITE_ROLES)
  @ApiOperation({ summary: 'Add one tier row to the ladder' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCommissionRuleDto,
  ) {
    return this.rules.create(user, dto);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  @ApiOperation({ summary: 'Update a single tier rule' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCommissionRuleDto,
  ) {
    return this.rules.update(user, id, dto);
  }

  /**
   * Soft-delete (set `isActive=false`). The row is preserved so historical
   * `CommissionSnapshot.commissionRuleId` references stay resolvable.
   */
  @Delete(':id')
  @Roles(...WRITE_ROLES)
  @ApiOperation({ summary: 'Deactivate a tier rule (soft delete)' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.rules.softDelete(user, id);
  }

  @Post('bulk-upsert')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  @ApiOperation({ summary: 'Atomically replace tier ladders for many bundles' })
  bulkUpsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkUpsertCommissionRulesDto,
  ) {
    return this.rules.bulkUpsert(user, dto);
  }

  /**
   * Diagnostic: compute commission for an existing sales order without
   * persisting any records. Useful for previews and as a calc-engine
   * surface that the smoke can exercise end-to-end.
   */
  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview commission for a sales order (no persistence)',
  })
  calculate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CalculateCommissionDto,
  ) {
    return this.rules.calculateForOrder(user, dto);
  }
}
