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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateQuarterTargetDto } from './dto/create-quarter-target.dto';
import { QuarterProgressQueryDto } from './dto/quarter-progress.query.dto';
import { UpdateQuarterTargetDto } from './dto/update-quarter-target.dto';
import { TargetProgressService } from './target-progress.service';
import { TargetsService } from './targets.service';

/**
 * Branch quarterly revenue targets.
 *
 *   POST   /targets                                        — create
 *   PATCH  /targets/:id                                    — update
 *   GET    /targets/branch/:branchId?year=YYYY&quarter=N   — fetch one
 *   GET    /targets/branch/:branchId/progress?year&quarter — live progress
 *
 * Authorization summary:
 *   - WRITE (POST/PATCH): ADMIN, SUPER_BRANCH_MANAGER, BRANCH_MANAGER.
 *     Branch-scoping (BM may only write for their own branch) is
 *     enforced inside the service via `assertBranchAccess`.
 *   - READ: any authenticated user. Branch-scoping (CS/DOCTOR see only
 *     their own branch) is enforced inside the service.
 *
 * The class-level @Roles is intentionally permissive — the actual
 * authorization happens in the service layer's `assertBranchAccess`
 * call so that read endpoints stay open to all authenticated users.
 */
@ApiTags('targets')
@ApiBearerAuth('bearer')
@Controller('targets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TargetsController {
  constructor(
    private readonly targets: TargetsService,
    private readonly progress: TargetProgressService,
  ) {}

  // ────────────────────── Reads (any auth'd user) ──────────────────────

  @Get('branch/:branchId')
  @ApiOperation({
    summary:
      'Fetch the quarterly target for (branchId, year, quarter). 404 if not yet configured.',
  })
  findForQuarter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Query() query: QuarterProgressQueryDto,
  ) {
    return this.targets.findForQuarter(
      user,
      branchId,
      query.year,
      query.quarter,
    );
  }

  @Get('branch/:branchId/progress')
  @ApiOperation({
    summary:
      'Live quarterly progress: target vs actual revenue (from completed sales orders), grouped by commission group.',
  })
  getProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Query() query: QuarterProgressQueryDto,
  ) {
    return this.progress.getQuarterProgress(
      user,
      branchId,
      query.year,
      query.quarter,
    );
  }

  // ────────────────────── Writes (manager roles) ──────────────────────

  @Post()
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  @ApiOperation({
    summary:
      'Create a quarterly target. Sum of category targetAmounts must equal totalTarget.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateQuarterTargetDto,
  ) {
    return this.targets.create(user, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  @ApiOperation({
    summary:
      'Partial update. Supplying `categories` REPLACES the entire category set; the resulting (possibly new) sum must equal the (possibly new) totalTarget.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateQuarterTargetDto,
  ) {
    return this.targets.update(user, id, dto);
  }
}
