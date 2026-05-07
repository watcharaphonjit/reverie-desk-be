import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateSalesOrderItemDto } from './create-sales-order.dto';

/**
 * Editable subset of a sales order. `branchId` / `customerId` / `leadId`
 * are intentionally locked once the order is created — changing them
 * would silently invalidate audit history, commission rules, and stock
 * usage records that already reference the original tuple.
 *
 * Updates are only allowed while the order is still in DRAFT (enforced
 * in the service). The order-level `discountAmount` is derived from the
 * line items, so to change discounts you replace `items`.
 */
export class UpdateSalesOrderDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSalesOrderItemDto)
  items?: CreateSalesOrderItemDto[];

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
}
