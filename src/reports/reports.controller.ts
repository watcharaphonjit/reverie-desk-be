import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AppointmentsReportQueryDto } from './dto/appointments-report-query.dto';
import { CommissionsReportQueryDto } from './dto/commissions-report-query.dto';
import { InventoryReportQueryDto } from './dto/inventory-report-query.dto';
import { PaymentsReportQueryDto } from './dto/payments-report-query.dto';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { ServiceEventsReportQueryDto } from './dto/service-events-report-query.dto';
import { WalletsReportQueryDto } from './dto/wallets-report-query.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth('bearer')
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('REPORT_VIEW')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  sales(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SalesReportQueryDto,
  ) {
    return this.reports.sales(user, query);
  }

  @Get('payments')
  payments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaymentsReportQueryDto,
  ) {
    return this.reports.payments(user, query);
  }

  @Get('service-events')
  serviceEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ServiceEventsReportQueryDto,
  ) {
    return this.reports.serviceEvents(user, query);
  }

  @Get('appointments')
  appointments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AppointmentsReportQueryDto,
  ) {
    return this.reports.appointments(user, query);
  }

  @Get('inventory')
  inventory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: InventoryReportQueryDto,
  ) {
    return this.reports.inventory(user, query);
  }

  @Get('commissions')
  commissions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CommissionsReportQueryDto,
  ) {
    return this.reports.commissions(user, query);
  }

  @Get('wallets')
  wallets(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletsReportQueryDto,
  ) {
    return this.reports.wallets(user, query);
  }
}
