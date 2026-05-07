import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateLeadDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsPhoneNumber('TH')
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

  @IsString()
  branchId!: string;

  /** Optional pre-existing customer to link. */
  @IsOptional()
  @IsString()
  customerId?: string;
}
