import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateSalesOrderItemDto {
  @IsString()
  serviceId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  /**
   * Override price for this line. If omitted, the service's `basePrice` is used.
   * Provided as a number for ease of validation; persisted as Decimal(18,2).
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;

  /** Per-line discount in absolute currency units. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;
}

export class CreateSalesOrderDto {
  @IsString()
  branchId!: string;

  @IsString()
  customerId!: string;

  /**
   * Optional. Walk-in / repeat-customer / in-clinic upsell orders may not
   * trace back to a lead. When provided, the lead must belong to the same
   * branch and either be unlinked or already linked to the same customer.
   */
  @IsOptional()
  @IsString()
  leadId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSalesOrderItemDto)
  items!: CreateSalesOrderItemDto[];

  /**
   * Tax as an absolute amount (already calculated by the caller). Kept absolute
   * because Thailand's clinic tax handling varies (per-service VAT exemptions,
   * fixed surcharges) and we don't want to bake a single rate into the API.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  depositRequired?: number;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  currency?: string;
}
