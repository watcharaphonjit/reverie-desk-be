import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class GeneralSettingsDto {
  @IsOptional()
  @IsString()
  organizationName?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  defaultBranchId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  reportWindowDays?: number;
}

export class FinanceSettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  commissionLockDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  walletExpiryReminderDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  outstandingWarningThreshold?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  receivingAccounts?: string[];
}

export class InventorySettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000)
  lowStockThreshold?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  nearExpiryDays?: number;
}

export class NotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enableInApp?: boolean;

  @IsOptional()
  @IsBoolean()
  enableEmail?: boolean;

  @IsOptional()
  @IsBoolean()
  enableSms?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  dailyDigestHour?: number;
}

export class AutomationSettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  appointmentReminderHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  leadFollowUpDays?: number;

  @IsOptional()
  @IsBoolean()
  enableDailyDigest?: boolean;
}

export class LeadsSettingsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  socialPages?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  procedureTypes?: string[];
}

export class UpdateSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GeneralSettingsDto)
  general?: GeneralSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => FinanceSettingsDto)
  finance?: FinanceSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => InventorySettingsDto)
  inventory?: InventorySettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationSettingsDto)
  notifications?: NotificationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AutomationSettingsDto)
  automation?: AutomationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeadsSettingsDto)
  leads?: LeadsSettingsDto;
}
