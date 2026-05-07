import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Draw a portion of an open container during a customer service event.
 * The caller must specify which event + service the usage belongs to so the
 * resulting `ServiceStockUsage` row is correctly attributed.
 */
export class UseContainerDto {
  @IsString()
  customerServiceEventId!: string;

  @IsString()
  serviceId!: string;

  /** Amount drawn in the stock item's primary unit (e.g., units of Botox). */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  quantityPrimaryUsed!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
