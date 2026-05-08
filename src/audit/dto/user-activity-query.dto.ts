import { Type } from 'class-transformer';
import { IsDateString, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class UserActivityQueryDto extends PaginationDto {
  @IsOptional()
  @IsDateString()
  @Type(() => String)
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @Type(() => String)
  endDate?: string;
}
