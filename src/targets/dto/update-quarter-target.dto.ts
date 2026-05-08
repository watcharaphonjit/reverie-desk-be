import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuarterTargetCategoryDto } from './create-quarter-target.dto';

/**
 * Partial update for an existing target. Fields:
 *   - `totalTarget` (optional): the new ceiling.
 *   - `categories`  (optional): if present, REPLACES the existing
 *     category set wholesale (atomic, drops then re-creates inside a
 *     single `$transaction`). Mirroring `bulk-upsert` semantics from
 *     the commission-rules module so admin tooling can edit ladders
 *     one round-trip at a time.
 *
 * Sum-validation rule (service-layer):
 *   - if BOTH `totalTarget` and `categories` are supplied, the sum of
 *     the new categories must equal the new totalTarget.
 *   - if only `categories` is supplied, the sum must equal the
 *     persisted `totalTarget`.
 *   - if only `totalTarget` is supplied, the new totalTarget must
 *     equal the sum of the existing categories.
 *
 * Note: `branchId`, `year`, `quarter` are immutable — they form the
 * unique identity of a target. Editing them would just be a delete +
 * recreate.
 */
export class UpdateQuarterTargetDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalTarget?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuarterTargetCategoryDto)
  categories?: QuarterTargetCategoryDto[];
}
