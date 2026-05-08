import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CommissionValueType } from '@prisma/client';

/**
 * Mutable fields on a CommissionRule. Identity fields (branchId,
 * commissionType, serviceGroupCode) are deliberately omitted: moving a
 * tier between (branch, group, type) clusters obscures the audit
 * history. Use DELETE + POST instead.
 */
export class UpdateCommissionRuleDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimumAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  value?: number;

  @IsOptional()
  @IsEnum(CommissionValueType)
  valueType?: CommissionValueType;

  @IsOptional()
  @IsString()
  roleId?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  /**
   * Pass `null` to remove an existing endsAt (re-activate indefinitely).
   * Send a date string to set / move it.
   */
  @IsOptional()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
