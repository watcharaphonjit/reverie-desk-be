import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import {
  CommissionType,
  CommissionValueType,
  ServiceGroupCode,
} from '@prisma/client';

/**
 * Create a single tier in the (branch, commissionGroup) ladder.
 *
 * For replacing an entire ladder atomically, prefer
 * `POST /commission-rules/bulk-upsert`. This single-row endpoint exists
 * for surgical edits — adding one new tier without disturbing siblings.
 *
 * Field-name note:
 *   - The spec uses `commissionGroup` and `minimumAmount`. The persisted
 *     columns are `serviceGroupCode` and `minAmount` for historical
 *     reasons; the service translates between the two names.
 */
export class CreateCommissionRuleDto {
  @IsString()
  branchId!: string;

  @IsEnum(ServiceGroupCode, {
    message: 'commissionGroup must be one of the ServiceGroupCode values',
  })
  commissionGroup!: ServiceGroupCode;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimumAmount!: number;

  @IsEnum(CommissionValueType)
  valueType!: CommissionValueType;

  /**
   * For FIXED, the absolute payout amount (THB). For PERCENTAGE, a
   * fraction between 0 and 1 (e.g. `0.05` = 5%). The service rejects
   * PERCENTAGE > 1 with a 400.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  value!: number;

  @IsOptional()
  @IsString()
  roleId?: string | null;

  @IsOptional()
  @IsEnum(CommissionType)
  commissionType?: CommissionType;

  /**
   * Optional schedule window. `startsAt` defaults to now; `endsAt` is
   * inclusive — once `now > endsAt` the row is no longer matched even
   * if `isActive=true`.
   */
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
