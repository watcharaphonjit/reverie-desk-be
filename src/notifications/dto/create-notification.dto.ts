import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NotificationChannel, NotificationType } from '@prisma/client';

/**
 * DTO for `POST /notifications` — admin/system broadcast endpoint.
 * Automation rules use the in-process `notify()` helper directly and
 * never go through this DTO.
 */
export class CreateNotificationDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsString()
  @MaxLength(160)
  title!: string;

  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsEnum(NotificationType)
  type!: NotificationType;

  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
