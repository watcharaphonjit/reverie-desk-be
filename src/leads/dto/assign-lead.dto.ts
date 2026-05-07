import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AssignLeadDto {
  @IsString()
  assignedToUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
