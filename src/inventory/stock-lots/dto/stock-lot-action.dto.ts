import { IsString, MaxLength, MinLength } from 'class-validator';

export class StockLotActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
