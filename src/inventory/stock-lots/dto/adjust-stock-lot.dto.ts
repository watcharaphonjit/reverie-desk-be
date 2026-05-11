import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum StockAdjustmentReason {
  PHYSICAL_RECOUNT = 'PHYSICAL_RECOUNT',
  DAMAGE = 'DAMAGE',
  DISPOSAL = 'DISPOSAL',
  CORRECTION = 'CORRECTION',
}

export class AdjustStockLotDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  quantityOnHand!: number;

  @IsEnum(StockAdjustmentReason)
  reason!: StockAdjustmentReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
