import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Open a multi-use container drawn from a stock lot. The container's
 * `stockItemId`, `warehouseId`, and `initialQtyPrimary` are normally derived
 * from the lot + stock item (`conversionFactor`), so the only truly
 * required field is `stockLotId`. The remaining fields are accepted and,
 * when present, *validated against* the lot — passing them as a cross-check
 * is supported but they cannot override the server's derived values.
 */
export class OpenContainerDto {
  @IsString()
  stockLotId!: string;

  /** Optional belt-and-suspenders: must equal the lot's stockItemId. */
  @IsOptional()
  @IsString()
  stockItemId?: string;

  /** Optional belt-and-suspenders: must equal the lot's warehouseId. */
  @IsOptional()
  @IsString()
  warehouseId?: string;

  /** Optional belt-and-suspenders: must equal the stock item's conversionFactor. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  initialQtyPrimary?: number;

  /**
   * In-use shelf life of the opened container (e.g., a reconstituted Botox
   * vial is good for 24h). Optional; when omitted, no in-use expiry is set.
   */
  @IsOptional()
  @IsDateString()
  expiryAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
