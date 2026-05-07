import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ConsumeStockDto {
  @IsString()
  stockLotId!: string;

  /**
   * Quantity to deduct, in the stock item's primary unit.
   * Stored as Decimal(18,6) so up to 6dp is accepted.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantity!: number;

  /** Optional reference; not mutated in this iteration (see module notes). */
  @IsOptional()
  @IsString()
  openedContainerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
