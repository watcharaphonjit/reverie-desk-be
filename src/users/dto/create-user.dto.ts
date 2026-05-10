import { RoleCode, UserStatus } from '@prisma/client';
import {
  ArrayUnique,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(180)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/, {
    message:
      'Password must contain uppercase, lowercase, number, and a special character',
  })
  password!: string;

  /** Optional honorific (e.g. "Dr.", "Mr.", "Khun"). */
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
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Role codes to assign on creation (e.g. ['ADMIN']). Optional. */
  @IsOptional()
  @IsEnum(RoleCode, { each: true })
  @ArrayUnique()
  roles?: RoleCode[];
}
