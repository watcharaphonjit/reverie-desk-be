import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { WalletReferenceType, WalletType } from '@prisma/client';

export class DebitWalletDto {
  @IsString()
  customerId!: string;

  @IsOptional()
  @IsEnum(WalletType)
  walletType?: WalletType = WalletType.DEPOSIT;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsEnum(WalletReferenceType)
  referenceType?: WalletReferenceType;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
