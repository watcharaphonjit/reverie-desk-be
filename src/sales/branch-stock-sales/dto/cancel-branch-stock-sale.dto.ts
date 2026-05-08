import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelBranchStockSaleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
