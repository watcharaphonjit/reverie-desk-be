import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PurchaseReceiptItemDto {
  @IsString()
  stockItemId!: string;

  /** Defaults to the receipt-level `warehouseId` when omitted. */
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  lotCode!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantityReceived!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unitCost!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  purchaseReference?: string;

  @IsOptional()
  @IsDateString()
  manufacturedAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreatePurchaseReceiptDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  supplierId?: string;

  /**
   * Default warehouse for `items`. Each item may override its own
   * `warehouseId`; if neither receipt-level nor item-level is provided, the
   * item is rejected.
   */
  @IsOptional()
  @IsString()
  warehouseId?: string;

  /** Defaults to `now()` when omitted; drives the `PR-YYYYMMDD-XXXX` prefix. */
  @IsOptional()
  @IsDateString()
  purchasedAt?: string;

  /**
   * Optional. When supplied, the receipt is created together with one
   * `StockLot` + one `PURCHASE_IN` `StockMovement` per item, all inside a
   * single Prisma transaction. When omitted, only the header is created and
   * lots can be received later via `POST /stock-lots/receive`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReceiptItemDto)
  items?: PurchaseReceiptItemDto[];
}
