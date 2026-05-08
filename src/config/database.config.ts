import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  url: string;
  logQueries: boolean;
  logSlowQueriesMs: number;
}

/**
 * Database configuration. The connection string itself is required by Joi;
 * the toggles here govern whether Prisma logs every query (NODE_ENV-aware
 * default) and the slow-query threshold for structured logging.
 */
export default registerAs<DatabaseConfig>('database', () => {
  const env = process.env.NODE_ENV ?? 'development';
  return {
    url: process.env.DATABASE_URL!,
    logQueries:
      process.env.PRISMA_LOG_QUERIES === 'true' ||
      (env !== 'production' && process.env.PRISMA_LOG_QUERIES !== 'false'),
    logSlowQueriesMs: Number(process.env.PRISMA_SLOW_QUERY_MS ?? 250),
  };
});
