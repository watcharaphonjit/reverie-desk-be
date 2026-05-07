import { IsString } from 'class-validator';

export class ChangeBranchDto {
  @IsString()
  branchId!: string;
}
