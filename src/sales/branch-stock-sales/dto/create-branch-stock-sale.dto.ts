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

export class CreateBranchStockSaleItemDto {
  @IsString()
  stockItemId!: string;

  /** Total quantity in the stock item's primary unit. Server expands this
   *  into one or more BranchStockSaleItem rows via FEFO across active lots. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantity!: number;

  /** Unit price quoted to the customer; snapshotted onto each created sale
   *  item so subsequent price changes don't rewrite history. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
}

export class CreateBranchStockSaleDto {
  @IsString()
  branchId!: string;

  @IsString()
  salesChannelId!: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  /** Optional whole-sale discount applied to subtotal. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateBranchStockSaleItemDto)
  items!: CreateBranchStockSaleItemDto[];
}
