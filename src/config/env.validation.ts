/**
 * Joi schema for required environment variables. The intent is fail-fast:
 * if a deploy is missing or mistypes a critical env, NestFactory.create()
 * throws before any HTTP listener binds. Defaults are only applied for
 * non-critical convenience knobs (PORT, LOG_LEVEL, automation tunables).
 */
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),

  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().required(),

  // Redis is OPTIONAL at runtime: if these vars are absent the cache and
  // queue layers degrade to in-process / no-op. Production must set them.
  REDIS_HOST: Joi.string().hostname().optional(),
  REDIS_PORT: Joi.number().integer().min(1).max(65535).default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  REDIS_TLS: Joi.boolean().truthy('true').falsy('false').default(false),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  CACHE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  CACHE_DASHBOARD_TTL_SECONDS: Joi.number().integer().min(1).default(30),
  CACHE_REPORT_TTL_SECONDS: Joi.number().integer().min(1).default(300),

  // Automation tunables — every one has a sensible default so the system
  // boots without explicit overrides, but they are validated when present.
  LOW_STOCK_THRESHOLD: Joi.number().positive().default(5),
  EXPIRY_ALERT_DAYS: Joi.number().integer().positive().default(30),
  LEAD_FOLLOWUP_HOURS: Joi.number().positive().default(48),
  APPOINTMENT_REMINDER_WINDOW_HOURS: Joi.number().positive().default(24),
  WALLET_EXPIRY_NOTICE_DAYS: Joi.number().integer().positive().default(7),
  AUTOMATION_DISABLED: Joi.string().allow('').default(''),

  // Feature flags
  ENABLE_QUEUES: Joi.boolean().truthy('true').falsy('false').default(true),
  ENABLE_REQUEST_LOGGING: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),

  CORS_ORIGINS: Joi.string().allow('').default('*'),

  // Throttler tunables. Production defaults are tight; tests/CI override
  // via env to avoid spurious 429s in smoke runs.
  THROTTLE_DEFAULT_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_AUTH_LIMIT: Joi.number().integer().min(1).default(5),
  THROTTLE_ADMIN_LIMIT: Joi.number().integer().min(1).default(50),
  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_DISABLED: Joi.boolean().truthy('true').falsy('false').default(false),
}).unknown(true);
