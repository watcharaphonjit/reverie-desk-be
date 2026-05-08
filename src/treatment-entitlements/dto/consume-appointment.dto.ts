import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ConsumeAppointmentDto {
  /**
   * Optional note recorded against the audit row created when an
   * appointment redeems one session of its entitlement. Useful for
   * post-hoc reconciliation ("operator manually consumed after no-show
   * follow-up appointment").
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
