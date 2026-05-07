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
import { StockLotStatus } from '@prisma/client';

export enum StockLotSort {
  /**
   * First-Expired-First-Out: lots with the earliest `expiresAt` come first;
   * lots without an expiry are pushed to the end and ordered by oldest
   * `receivedAt` first. This is the canonical pick order for consumption.
   */
  FEFO = 'fefo',
  NEWEST = 'newest',
}

export class StockLotQueryDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  stockItemId?: string;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsEnum(StockLotStatus)
  status?: StockLotStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(StockLotSort)
  sort: StockLotSort = StockLotSort.FEFO;

  /** Inclusive range over `expiresAt`. */
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

export class ExpiringStockLotQueryDto {
  /** Lots with `expiresAt` in `[today, today + days]`. Default 30. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 30;

  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  stockItemId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
