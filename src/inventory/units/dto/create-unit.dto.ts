import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUnitDto {
  /** Short uppercase code, e.g. `ML`, `BOTTLE`. Auto-uppercased. */
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'code may contain letters, digits, underscore, hyphen only',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase().trim() : value,
  )
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
