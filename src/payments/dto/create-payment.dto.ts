import { PaymentMethod, PaymentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  salesOrderId!: string;

  /**
   * Numeric amount in the order's currency. Validated > 0; the service also
   * checks `existingPaid + amount <= order.totalAmount` to prevent overpayment.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsEnum(PaymentType)
  paymentType!: PaymentType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
