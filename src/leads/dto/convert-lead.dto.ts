import { Type } from 'class-transformer';
import {
  IsDate,
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
} from 'class-validator';

export class ConvertLeadDto {
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @IsOptional()
  @IsPhoneNumber('TH')
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  email?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  birthDate?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
