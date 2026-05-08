import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { RefundType } from '@prisma/client';

export class CreateRefundDto {
  @IsString()
  salesOrderId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(RefundType)
  refundType!: RefundType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * If true (default), refund completion will post a DEPOSIT wallet credit
   * for the customer. Set false for cases where the money is returned via
   * an external channel (cash drawer, bank transfer) and shouldn't be
   * routed through the wallet ledger.
   */
  @IsOptional()
  @IsBoolean()
  creditToWallet?: boolean = true;
}
