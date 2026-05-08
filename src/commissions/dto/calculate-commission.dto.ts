import { IsString } from 'class-validator';

/**
 * Trigger commission calculation for an existing sales order. Server walks
 * `salesOrder.items`, groups by `service.commissionGroupCode`, picks the
 * winning tier per group and returns a per-group breakdown. Persists no
 * records — purely a preview/diagnostic.
 */
export class CalculateCommissionDto {
  @IsString()
  salesOrderId!: string;
}
