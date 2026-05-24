import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  Min,
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

  @IsString()
  @IsPhoneNumber('TH')
  @MaxLength(30)
  phone!: string;

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

  /** Initial owner — defaults to creator when omitted. */
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  orgSalesAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  adsSalesAmount?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  procedureTypes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  depositStatus?: string;

  @IsOptional()
  @Type(() => Date)
  appointmentDate?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adsLink?: string;
}
