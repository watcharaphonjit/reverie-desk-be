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

export class ReceiveStockTransferItemDto {
  @IsString()
  itemId!: string;

  /**
   * Must be > 0 and ≤ `quantitySent`. The destination lot is created with
   * `quantityOnHand = quantityReceived` and a `TRANSFER_IN` movement is logged.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantityReceived!: number;

  /**
   * Optional override for the destination lot code. When omitted, we mint
   * `<sourceLotCode>-T<NNN>` to keep traceability tight while avoiding a
   * unique-constraint collision in the destination warehouse.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toLotCode?: string;
}

export class ReceiveStockTransferDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveStockTransferItemDto)
  items!: ReceiveStockTransferItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
