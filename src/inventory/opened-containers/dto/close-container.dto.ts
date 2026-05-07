import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Shared body for both `discard` and `expire` transitions. `reason` is an
 * optional free-form note that lands on the audit log + (for discard) the
 * resulting StockMovement note.
 */
export class CloseContainerDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
