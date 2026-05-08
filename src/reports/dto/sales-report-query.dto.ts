import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { SalesOrderStatus } from '@prisma/client';

export const GROUP_BY_BUCKETS = ['day', 'week', 'month'] as const;
export type GroupByBucket = (typeof GROUP_BY_BUCKETS)[number];

export class SalesReportQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;

  @IsOptional()
  @IsEnum(SalesOrderStatus)
  status?: SalesOrderStatus;

  @IsOptional()
  @IsString()
  createdByUserId?: string;

  @IsOptional()
  @IsIn(GROUP_BY_BUCKETS)
  groupBy?: GroupByBucket = 'day';
}
