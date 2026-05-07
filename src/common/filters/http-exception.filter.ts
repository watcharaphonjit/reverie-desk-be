import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export interface ErrorEnvelope {
  success: false;
  error: {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
    path: string;
    timestamp: string;
  };
}

/**
 * Global filter that produces the failure side of our response envelope:
 *   { success: false, error: { statusCode, code, message, details?, path, timestamp } }
 *
 * - HttpException → response uses its status & message (validation `details` from class-validator are preserved).
 * - Anything else → 500 with a generic message; the actual error is logged server-side.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, details } = this.unwrap(exception, isHttp);
    const code = isHttp
      ? exception.constructor.name
          .replace(/Exception$/, '')
          // PascalCase → SCREAMING_SNAKE_CASE: BadRequest → BAD_REQUEST
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toUpperCase()
      : 'INTERNAL_SERVER_ERROR';

    if (!isHttp) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorEnvelope = {
      success: false,
      error: {
        statusCode: status,
        code,
        message,
        ...(details === undefined ? {} : { details }),
        path: request.url,
        timestamp: new Date().toISOString(),
      },
    };

    response.status(status).json(body);
  }

  private unwrap(
    exception: unknown,
    isHttp: boolean,
  ): { message: string; details?: unknown } {
    if (!isHttp) {
      return {
        message:
          exception instanceof Error
            ? exception.message
            : 'Internal server error',
      };
    }

    const res = (exception as HttpException).getResponse();
    if (typeof res === 'string') return { message: res };

    const obj = res as Record<string, unknown>;
    const rawMessage = obj.message ?? obj.error ?? 'Error';

    // class-validator gives `message` as string[] of validation errors
    if (Array.isArray(rawMessage)) {
      return {
        message: 'Validation failed',
        details: rawMessage,
      };
    }
    return { message: String(rawMessage) };
  }
}
