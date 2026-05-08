import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { CommissionStatus, CommissionType, ServiceGroupCode } from '@prisma/client';

export const COMMISSION_GROUP_BY = ['user', 'branch', 'group'] as const;
export type CommissionGroupBy = (typeof COMMISSION_GROUP_BY)[number];

export class CommissionsReportQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  recipientUserId?: string;

  @IsOptional()
  @IsEnum(CommissionStatus)
  status?: CommissionStatus;

  @IsOptional()
  @IsEnum(CommissionType)
  type?: CommissionType;

  @IsOptional()
  @IsEnum(ServiceGroupCode)
  serviceGroupCode?: ServiceGroupCode;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;

  @IsOptional()
  @IsIn(COMMISSION_GROUP_BY)
  groupBy?: CommissionGroupBy = 'user';
}
