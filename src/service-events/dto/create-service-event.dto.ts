import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateServiceEventDto {
  /**
   * Appointment the service is being performed under. Required: the spec
   * says appointment must be CHECKED_IN, and customer/service must match
   * the appointment, so the appointment is the source of truth for those
   * fields. We re-validate them anyway to fail loudly on mismatches.
   */
  @IsString()
  appointmentId!: string;

  @IsString()
  customerId!: string;

  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  doctorUserId?: string;

  @IsOptional()
  @IsString()
  employeeUserId?: string;

  /** Optional override; defaults to `now()` when omitted. */
  @IsOptional()
  @IsDateString()
  performedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
