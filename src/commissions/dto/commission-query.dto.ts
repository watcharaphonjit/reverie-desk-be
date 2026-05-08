import { IsEnum, IsOptional, IsString } from 'class-validator';
import {
  CommissionStatus,
  CommissionType,
  ServiceGroupCode,
} from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

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
}
