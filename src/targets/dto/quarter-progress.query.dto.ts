import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Query params for `GET /targets/branch/:branchId?year&quarter` and
 * `GET /targets/branch/:branchId/progress?year&quarter`. Both
 * endpoints share the same query shape, which is why this DTO is
 * extracted.
 *
 * `year`/`quarter` are required so the client must always specify a
 * concrete quarter — there is no "current" inference (would push tz
 * politics into the API).
 */
export class QuarterProgressQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quarter!: number;
}
