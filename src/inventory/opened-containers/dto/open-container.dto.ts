import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Open a multi-use container drawn from a stock lot. The container's
 * `stockItemId` and `warehouseId` are derived from the lot — the caller only
 * needs to identify which lot is being opened.
 */
export class OpenContainerDto {
  @IsString()
  stockLotId!: string;

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
