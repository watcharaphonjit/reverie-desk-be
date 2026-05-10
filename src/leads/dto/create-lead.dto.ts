import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLeadDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  title?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  middleName?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsPhoneNumber('TH')
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lineId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  facebookName?: string;

  /** Free-form acquisition source (campaign code, referrer, etc). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

  /** Free-form contact channel (e.g. "Line OA", "Web", "Walk-in"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsString()
  branchId!: string;

  /** Optional pre-existing customer to link. */
  @IsOptional()
  @IsString()
  customerId?: string;
}
