import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

/**
 * Wraps every successful controller response in `{ success: true, data: ... }`.
 *
 * If a handler already returns an object with `success` boolean (e.g. it
 * crafted the envelope itself, or returned `{ success: false, ... }`),
 * the value is passed through untouched. Errors flow through the exception
 * filter, not this interceptor.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T,
  SuccessEnvelope<T> | T
> {
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T> | T> {
    return next.handle().pipe(
      map((data) => {
        if (
          data !== null &&
          typeof data === 'object' &&
          'success' in (data as Record<string, unknown>)
        ) {
          return data;
        }
        return { success: true, data };
      }),
    );
  }
}
