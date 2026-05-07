import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class DispatchStockTransferItemDto {
  @IsString()
  itemId!: string;

  /** Must be > 0 and ≤ `quantityRequested`. Verified at dispatch time. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantitySent!: number;
}

export class DispatchStockTransferDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DispatchStockTransferItemDto)
  items!: DispatchStockTransferItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
