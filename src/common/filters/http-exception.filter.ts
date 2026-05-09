import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    correlationId?: string;
  };
}

/**
 * Global filter that produces the failure side of our response envelope:
 *   { success: false, error: { code, message, details, ... } }
 *
 * Handled error families:
 *   - HttpException             → use its status & message; preserve
 *                                 class-validator `details` arrays.
 *   - Prisma known errors       → map P2002/P2003/P2025/etc to the
 *                                 closest HTTP status with a stable
 *                                 SCREAMING_SNAKE code so clients can
 *                                 branch on `error.code`.
 *   - Prisma validation errors  → 400 BAD_REQUEST, message preserved.
 *   - Anything else             → 500 INTERNAL_SERVER_ERROR; the actual
 *                                 stack is logged server-side only.
 *
 * The correlation ID is read off `req.id` (set by pino-http) so every
 * error envelope can be cross-referenced with structured logs.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const mapped = this.map(exception);

    if (mapped.statusCode >= 500) {
      this.logger.error(
        `[${request.id ?? '-'}] ${request.method} ${request.url} → ${mapped.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorEnvelope = {
      success: false,
      error: {
        statusCode: mapped.statusCode,
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
        path: request.url,
        timestamp: new Date().toISOString(),
        ...(request.id ? { correlationId: request.id } : {}),
      },
    };
    response.status(mapped.statusCode).json(body);
  }

  private map(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const code = pascalToSnakeUpper(
        exception.constructor.name.replace(/Exception$/, ''),
      );
      if (typeof res === 'string')
        return { statusCode: status, code, message: res };
      const obj = res as Record<string, unknown>;
      const raw = obj.message ?? obj.error ?? 'Error';
      if (Array.isArray(raw)) {
        return {
          statusCode: status,
          code,
          message: 'Validation failed',
          details: raw,
        };
      }
      return { statusCode: status, code, message: JSON.stringify(raw) };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return mapPrismaKnown(exception);
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'PRISMA_VALIDATION_ERROR',
        message: 'Invalid data passed to database layer',
        details: exception.message.split('\n').slice(-3),
      };
    }
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database connection unavailable',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message:
        exception instanceof Error
          ? exception.message
          : 'Internal server error',
    };
  }
}

function pascalToSnakeUpper(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function mapPrismaKnown(err: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
} {
  // Common Prisma error codes — see https://www.prisma.io/docs/reference/api-reference/error-reference
  switch (err.code) {
    case 'P2002':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'UNIQUE_CONSTRAINT_VIOLATION',
        message: 'A record with these unique fields already exists',
        details: { target: err.meta?.target },
      };
    case 'P2003':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'FOREIGN_KEY_VIOLATION',
        message: 'Referenced record does not exist',
        details: { field: err.meta?.field_name },
      };
    case 'P2025':
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: 'RECORD_NOT_FOUND',
        message: 'Required record was not found',
      };
    case 'P2014':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'RELATION_VIOLATION',
        message: 'Operation would violate a required relation',
      };
    case 'P2034':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'TRANSACTION_CONFLICT',
        message: 'Transaction failed due to a write conflict; retry',
      };
    default:
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: `PRISMA_${err.code}`,
        message: 'Database error',
      };
  }
}
