import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { StockTransferStatus } from '@prisma/client';

export class StockTransferQueryDto {
  @IsOptional()
  @IsString()
  fromWarehouseId?: string;

  @IsOptional()
  @IsString()
  toWarehouseId?: string;

  @IsOptional()
  @IsEnum(StockTransferStatus)
  status?: StockTransferStatus;

  @IsOptional()
  @IsString()
  search?: string;

  /** Inclusive range over `createdAt`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
