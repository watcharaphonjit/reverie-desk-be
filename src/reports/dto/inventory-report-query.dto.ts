import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { StockMovementType } from '@prisma/client';

export class InventoryReportQueryDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  stockItemId?: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  movementType?: StockMovementType;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;
}
