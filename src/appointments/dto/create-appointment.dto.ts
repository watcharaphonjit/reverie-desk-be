import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAppointmentDto {
  @IsString()
  salesOrderId!: string;

  @IsString()
  customerId!: string;

  @IsString()
  serviceId!: string;

  /** ISO-8601 datetime, e.g. `2026-05-08T09:30:00+07:00`. */
  @IsDateString()
  scheduledAt!: string;

  @IsOptional()
  @IsString()
  doctorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
