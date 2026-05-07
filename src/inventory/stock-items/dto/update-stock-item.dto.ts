import { ConsumptionStrategy, StockItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `sku` is intentionally immutable once created — it's referenced by stock
 * lots, transfers, and movement history. Use a soft-delete + recreate flow
 * if a code needs to change.
 */
export class UpdateStockItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsEnum(StockItemType)
  type?: StockItemType;

  @IsOptional()
  @IsString()
  primaryUnitId?: string;

  @IsOptional()
  @IsString()
  secondaryUnitId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  conversionFactor?: number | null;

  @IsOptional()
  @IsEnum(ConsumptionStrategy)
  consumptionStrategy?: ConsumptionStrategy;

  @IsOptional()
  @IsBoolean()
  isSellable?: boolean;

  @IsOptional()
  @IsBoolean()
  trackLot?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
