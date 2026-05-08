import { registerAs } from '@nestjs/config';

export interface RedisConfig {
  host: string | null;
  port: number;
  password?: string;
  db: number;
  tls: boolean;
  enabled: boolean;
  defaultTtlSeconds: number;
  dashboardTtlSeconds: number;
  reportTtlSeconds: number;
}

/**
 * Redis configuration. `enabled` is computed from the presence of
 * REDIS_HOST: when no host is supplied (e.g. a developer machine without
 * docker), the cache and queue layers fall back to safe in-process
 * substitutes — see CacheService and QueueModule.
 */
export default registerAs<RedisConfig>('redis', () => {
  const host = process.env.REDIS_HOST?.trim() || null;
  return {
    host,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    tls: process.env.REDIS_TLS === 'true',
    enabled: host !== null,
    defaultTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 60),
    dashboardTtlSeconds: Number(process.env.CACHE_DASHBOARD_TTL_SECONDS ?? 30),
    reportTtlSeconds: Number(process.env.CACHE_REPORT_TTL_SECONDS ?? 300),
  };
});
