import { IsEnum, IsOptional, IsString } from 'class-validator';
import { RefundStatus, RefundType } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class RefundQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  salesOrderId?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;

  @IsOptional()
  @IsEnum(RefundType)
  refundType?: RefundType;
}
