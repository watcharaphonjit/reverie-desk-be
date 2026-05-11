import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class RescheduleAppointmentDto {
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

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class NoShowAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CheckInAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CompleteAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
