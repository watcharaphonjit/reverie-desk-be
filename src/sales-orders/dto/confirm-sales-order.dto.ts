import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ConfirmSalesOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelSalesOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
