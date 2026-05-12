import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  CommissionStatus,
  CommissionType,
  ServiceGroupCode,
} from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export const COMMISSION_PERIOD_FIELDS = [
  'CREATED_AT',
  'ELIGIBLE_AT',
  'LOCKED_AT',
  'PAID_AT',
] as const;

export type CommissionPeriodField = (typeof COMMISSION_PERIOD_FIELDS)[number];

export class CommissionQueryDto extends PaginationDto {
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
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsEnum(ServiceGroupCode)
  group?: ServiceGroupCode;

  @IsOptional()
  @IsString()
  salesOrderId?: string;

  @IsOptional()
  @IsIn(COMMISSION_PERIOD_FIELDS)
  periodField?: CommissionPeriodField = 'CREATED_AT';

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  from?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  to?: string;
}
