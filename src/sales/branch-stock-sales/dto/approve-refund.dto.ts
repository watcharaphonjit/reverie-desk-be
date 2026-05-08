import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveRefundDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
