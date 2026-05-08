import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

export const APPT_GROUP_BY = ['doctor', 'branch'] as const;
export type ApptGroupBy = (typeof APPT_GROUP_BY)[number];

export class AppointmentsReportQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  doctorUserId?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;

  @IsOptional()
  @IsIn(APPT_GROUP_BY)
  groupBy?: ApptGroupBy = 'branch';
}
