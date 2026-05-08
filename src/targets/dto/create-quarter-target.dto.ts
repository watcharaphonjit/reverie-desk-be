import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ServiceGroupCode } from '@prisma/client';

/**
 * One row inside a target's category breakdown.
 *
 * Reuses `ServiceGroupCode` (the canonical commission-group enum the
 * codebase already uses on `Service.commissionGroupCode` and
 * `CommissionRule.serviceGroupCode`). The HTTP-facing field name is
 * `commissionGroup` to match the spec; on the wire and inside the
 * service we map this to `serviceGroupCode` only when persisting to
 * `BranchQuarterTargetCategory.commissionGroup` — actually they share
 * the same enum so no mapping is needed.
 */
export class QuarterTargetCategoryDto {
  @IsEnum(ServiceGroupCode, {
    message: 'commissionGroup must be one of the ServiceGroupCode values',
  })
  commissionGroup!: ServiceGroupCode;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  targetAmount!: number;
}

/**
 * Create a quarterly target for `(branchId, year, quarter)`. The
 * service layer enforces:
 *   - `categories[*].targetAmount` summed === `totalTarget` (±0.01 tol)
 *   - no duplicate `commissionGroup` rows
 *   - `(branchId, year, quarter)` is unique (DB constraint surfaces 409)
 *   - branch scope: BRANCH_MANAGER may only create for their own branch
 */
export class CreateQuarterTargetDto {
  @IsString()
  branchId!: string;

  /**
   * Calendar year (e.g. 2026). Soft bounds keep the data sane —
   * historical backfills before 2020 and projections beyond 2100 are
   * almost certainly typos.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quarter!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalTarget!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuarterTargetCategoryDto)
  categories!: QuarterTargetCategoryDto[];
}
