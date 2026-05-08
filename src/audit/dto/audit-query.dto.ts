import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { AuditAction } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class AuditQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  /** Inclusive lower bound on `createdAt`. ISO-8601 string. */
  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  /** Exclusive upper bound on `createdAt`. ISO-8601 string. */
  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;
}
