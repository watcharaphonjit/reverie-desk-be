import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ExpireEntitlementDto {
  /**
   * Optional human-readable reason recorded on the audit row. Common
   * values: "policy expiry", "customer-requested cancellation", "refunded".
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
