import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Params as PinoModuleOptions } from 'nestjs-pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.passwordHash',
  'req.body.token',
  'req.body.refreshToken',
  'res.headers["set-cookie"]',
];

const HEALTH_PATTERN = /^\/health(\/|$)/;

/**
 * Build the nestjs-pino options. Pretty in dev/test, JSON in prod.
 *
 * Correlation IDs:
 * - Honour an inbound `x-request-id` header so a caller's correlation token
 *   propagates across services.
 * - Otherwise mint a fresh UUID v4 — pino-http logs it as `req.id` and
 *   echoes it in the `x-request-id` response header so clients can trace.
 *
 * Sensitive fields (auth headers, passwords) are redacted at the logger
 * boundary so we never accidentally ship them to a log aggregator.
 */
export function buildPinoOptions(): PinoModuleOptions {
  const env = process.env.NODE_ENV ?? 'development';
  const isProd = env === 'production';
  const level = process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info');

  return {
    pinoHttp: {
      level,
      genReqId: (req: IncomingMessage) => {
        const incoming = (req.headers['x-request-id'] ??
          req.headers['x-correlation-id']) as string | undefined;
        return incoming && incoming.length > 0 ? incoming : randomUUID();
      },
      // Echo correlation ID back to the client.
      customProps: (req) => ({
        correlationId: (req as IncomingMessage & { id?: string }).id ?? null,
      }),
      autoLogging: {
        ignore: (req: IncomingMessage) =>
          HEALTH_PATTERN.test(req.url ?? ''),
      },
      customLogLevel: (
        _req: IncomingMessage,
        res: ServerResponse,
        err: Error | undefined,
      ) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,context,req,res',
              messageFormat:
                '[{context}] {msg} {req.method} {req.url} {res.statusCode} {responseTime}ms',
            },
          },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        req: (req: { id?: string; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
