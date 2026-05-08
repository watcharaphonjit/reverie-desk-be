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

export class RefundBranchStockSaleItemDto {
  @IsString()
  saleItemId!: string;

  /** Quantity to refund in the stock item's primary unit. Must be ≤ the
   *  remaining (un-refunded) quantity on the original sale item. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantity!: number;
}

export class RefundBranchStockSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RefundBranchStockSaleItemDto)
  items!: RefundBranchStockSaleItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
