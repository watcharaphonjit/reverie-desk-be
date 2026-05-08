import { registerAs } from '@nestjs/config';

export type AppEnvName = 'development' | 'staging' | 'production' | 'test';

export interface AppConfig {
  env: AppEnvName;
  port: number;
  isProd: boolean;
  isTest: boolean;
  corsOrigins: string[] | true;
  enableRequestLogging: boolean;
}

/**
 * Application-level config: env name, listen port, CORS, request-logging
 * toggle. Reads from process.env after Joi has validated/coerced values.
 */
export default registerAs<AppConfig>('app', () => {
  const env = (process.env.NODE_ENV ?? 'development') as AppEnvName;
  const raw = (process.env.CORS_ORIGINS ?? '*').trim();
  const corsOrigins =
    raw === '*' || raw === ''
      ? (true as const)
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  return {
    env,
    port: Number(process.env.PORT ?? 3000),
    isProd: env === 'production',
    isTest: env === 'test',
    corsOrigins,
    enableRequestLogging: process.env.ENABLE_REQUEST_LOGGING !== 'false',
  };
});
