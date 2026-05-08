import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { CommissionValueType, ServiceGroupCode } from '@prisma/client';

export class CommissionTierDto {
  /** Inclusive lower bound on `groupSubtotal` for this tier to apply. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimum!: number;

  /**
   * For FIXED, this is the absolute amount paid out (THB). For PERCENTAGE,
   * a fractional rate (e.g. `0.03` = 3%). Cross-field validation in the
   * service ensures `rate ≤ 1` for PERCENTAGE.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  rate!: number;

  /**
   * Discriminator for the `rate` field. Two spec drafts use either `type`
   * or `valueType`; we standardise on `type` here. Callers that send
   * `valueType` will see a 400 — pre-mapping in the API layer is left to
   * the caller (or to a future controller-level interceptor).
   */
  @IsEnum(CommissionValueType, {
    message: 'type must be FIXED or PERCENTAGE',
  })
  type!: CommissionValueType;
}

export class CommissionGroupBundleDto {
  @IsString()
  branchId!: string;

  @IsEnum(ServiceGroupCode)
  serviceGroupCode!: ServiceGroupCode;

  /**
   * Optional — defaults to `SALES_COMMISSION` in the service. Kept here
   * so callers can author both LEAD_REWARD and SALES_COMMISSION ladders
   * via the same endpoint when they want to.
   */
  @IsOptional()
  @IsEnum(['LEAD_REWARD', 'SALES_COMMISSION'])
  commissionType?: 'LEAD_REWARD' | 'SALES_COMMISSION';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CommissionTierDto)
  tiers!: CommissionTierDto[];
}

export class BulkUpsertCommissionRulesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CommissionGroupBundleDto)
  bundles!: CommissionGroupBundleDto[];
}
