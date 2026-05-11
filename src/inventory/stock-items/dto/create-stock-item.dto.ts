import { ConsumptionStrategy, StockItemType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateStockItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'sku may contain letters, digits, underscore, hyphen only',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.toUpperCase().trim() : value,
  )
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsEnum(StockItemType)
  type!: StockItemType;

  @IsString()
  primaryUnitId!: string;

  @IsOptional()
  @IsString()
  secondaryUnitId?: string;

  /**
   * Required iff `secondaryUnitId` is provided. Up to 6dp.
   * Cross-field rule enforced in the service layer.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  conversionFactor?: number;

  @IsEnum(ConsumptionStrategy)
  consumptionStrategy!: ConsumptionStrategy;

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
