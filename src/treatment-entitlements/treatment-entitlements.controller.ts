import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConsumeAppointmentDto } from './dto/consume-appointment.dto';
import { ExpireEntitlementDto } from './dto/expire-entitlement.dto';
import { TreatmentEntitlementsService } from './treatment-entitlements.service';

/**
 * Aggregates the four entitlement-related endpoints from the spec:
 *
 *   GET    /customers/:id/entitlements
 *   GET    /entitlements/:id
 *   POST   /appointments/:id/consume
 *   PATCH  /entitlements/:id/expire
 *
 * Single controller, no base path — each handler declares its own
 * fully-qualified route. The global `/api/v1` prefix is applied by
 * `main.ts`.
 */
@ApiTags('treatment-entitlements')
@ApiBearerAuth('bearer')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class TreatmentEntitlementsController {
  constructor(
    private readonly entitlements: TreatmentEntitlementsService,
  ) {}

  @Get('customers/:id/entitlements')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER', 'CS', 'DOCTOR')
  @ApiOperation({
    summary:
      'List all program entitlements held by a customer, with computed remainingSessions.',
  })
  listForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') customerId: string,
  ) {
    return this.entitlements.listForCustomer(user, customerId);
  }

  @Get('entitlements/:id')
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER', 'CS', 'DOCTOR')
  @ApiOperation({ summary: 'Fetch a single entitlement by id.' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.entitlements.findOne(user, id);
  }

  @Post('appointments/:id/consume')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER', 'DOCTOR')
  @ApiOperation({
    summary:
      'Idempotently redeem one session against the entitlement linked to this appointment. Safe to call alongside the auto-consume that fires on /appointments/:id/complete.',
  })
  consume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') appointmentId: string,
    @Body() dto: ConsumeAppointmentDto,
  ) {
    return this.entitlements.consumeForAppointment(
      user,
      appointmentId,
      dto.note,
    );
  }

  @Patch('entitlements/:id/expire')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'SUPER_BRANCH_MANAGER', 'BRANCH_MANAGER')
  @ApiOperation({
    summary:
      'Soft-expire an entitlement (sets expiredAt=now). Subsequent bookings/consumes are rejected. Idempotent.',
  })
  expire(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ExpireEntitlementDto,
  ) {
    return this.entitlements.expire(user, id, dto.reason);
  }
}
