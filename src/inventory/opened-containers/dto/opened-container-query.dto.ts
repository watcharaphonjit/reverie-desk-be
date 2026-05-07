import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { OpenedContainerStatus } from '@prisma/client';

export class OpenedContainerQueryDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  stockItemId?: string;

  @IsOptional()
  @IsString()
  stockLotId?: string;

  @IsOptional()
  @IsEnum(OpenedContainerStatus)
  status?: OpenedContainerStatus;

  /** Inclusive range over `expiryAt`. */
  @IsOptional()
  @IsDateString()
  expiringFrom?: string;

  @IsOptional()
  @IsDateString()
  expiringTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
