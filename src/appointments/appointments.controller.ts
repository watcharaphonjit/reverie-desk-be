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
import { AppointmentsService } from './appointments.service';
import { AppointmentQueryDto } from './dto/appointment-query.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import {
  CancelAppointmentDto,
  CheckInAppointmentDto,
  CompleteAppointmentDto,
  RescheduleAppointmentDto,
} from './dto/reschedule-appointment.dto';

@Controller('appointments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER', 'CS', 'DOCTOR')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAppointmentDto,
  ) {
    return this.appointments.create(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AppointmentQueryDto,
  ) {
    return this.appointments.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointments.findOne(user, id);
  }

  @Patch(':id/check-in')
  @HttpCode(HttpStatus.OK)
  checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CheckInAppointmentDto,
  ) {
    return this.appointments.checkIn(user, id, dto.note);
  }

  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'BRANCH_MANAGER', 'SUPER_BRANCH_MANAGER', 'DOCTOR')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CompleteAppointmentDto,
  ) {
    return this.appointments.complete(user, id, dto.note);
  }

  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.appointments.cancel(user, id, dto.reason);
  }

  @Patch(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    return this.appointments.reschedule(user, id, dto);
  }
}
