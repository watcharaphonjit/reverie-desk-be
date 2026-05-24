import { IsString } from 'class-validator';

export class LinkLeadCustomerDto {
  @IsString()
  customerId!: string;
}
