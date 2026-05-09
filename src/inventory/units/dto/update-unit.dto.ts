import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `code` is intentionally immutable once created — it's referenced by stock
 * items and changing it would silently invalidate any external reports or
 * exports already keyed on it.
 */
export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
