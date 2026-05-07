import { IsString } from 'class-validator';

export class AssignUserBranchDto {
  @IsString()
  branchId!: string;
}
