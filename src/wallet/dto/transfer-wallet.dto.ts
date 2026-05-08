import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { WalletType } from '@prisma/client';

export class TransferWalletDto {
  @IsString()
  fromCustomerId!: string;

  @IsString()
  toCustomerId!: string;

  @IsOptional()
  @IsEnum(WalletType)
  fromWalletType?: WalletType = WalletType.DEPOSIT;

  @IsOptional()
  @IsEnum(WalletType)
  toWalletType?: WalletType = WalletType.DEPOSIT;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
