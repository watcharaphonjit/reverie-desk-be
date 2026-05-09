import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateServiceEventDto {
  @IsString()
  customerId!: string;

  /**
   * Branch where the service is being performed. Required by the spec.
   * If `appointmentId` is supplied, this must equal `appointment.branchId`.
   */
  @IsString()
  branchId!: string;

  @IsString()
  serviceId!: string;

  /**
   * Appointment the service is being performed under. Optional — supports
   * walk-in service events that were not pre-booked. When provided we
   * additionally validate the appointment is `CHECKED_IN` and that
   * customer/service/branch match the appointment.
   */
  @IsOptional()
  @IsString()
  appointmentId?: string;

  /**
   * Optional sales order this event is being delivered against. Snapshotted
   * onto the event for billing/traceability. When `appointmentId` is also
   * present and the appointment links a different sales order, the request
   * is rejected — they must agree.
   */
  @IsOptional()
  @IsString()
  salesOrderId?: string;

  @IsOptional()
  @IsString()
  doctorUserId?: string;

  @IsOptional()
  @IsString()
  employeeUserId?: string;

  /** Defaults to `now()` when omitted. */
  @IsOptional()
  @IsDateString()
  performedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
