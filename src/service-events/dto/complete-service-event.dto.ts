import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteServiceEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
