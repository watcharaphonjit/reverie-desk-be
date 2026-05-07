import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelStockTransferDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
