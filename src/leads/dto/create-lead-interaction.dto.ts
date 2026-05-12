import { LeadInteractionType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLeadInteractionDto {
  @IsEnum(LeadInteractionType)
  type!: LeadInteractionType;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  outcome?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  nextActionAt?: Date;
}
