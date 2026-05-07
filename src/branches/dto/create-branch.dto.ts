import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBranchDto {
  /** Auto-uppercased. Letters, digits, hyphens, underscores. */
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'code may only contain letters, digits, hyphens, and underscores',
  })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}
