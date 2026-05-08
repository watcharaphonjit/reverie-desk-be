import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { RedisConfig } from '../config/redis.config';

interface InMemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * Cache facade backed by Redis when REDIS_HOST is configured, with a safe
 * in-memory LRU-like fallback for local dev / tests / CI without Redis.
 *
 * Why a hand-rolled fallback instead of cache-manager? Two reasons:
 *  1. The cache-manager v6 → v7 split introduced peer dependency churn
 *     with our existing keyv versions; a thin wrapper avoids the rabbit
 *     hole entirely.
 *  2. We want tight control over JSON serialization, key namespacing
 *     (`reverie:`), and the wrap()/getOrSet() pattern that report and
 *     dashboard endpoints actually need.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly cfg: RedisConfig;
  private readonly keyPrefix = 'reverie:';
  private readonly memory = new Map<string, InMemoryEntry>();
  private readonly memoryCap = 5000;
  private client: Redis | null = null;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<RedisConfig>('redis');
  }

  async onModuleInit(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.host) {
      this.logger.log(
        'REDIS_HOST not set — cache running in-process (NOT for production)',
      );
      return;
    }
    this.client = new Redis({
      host: this.cfg.host,
      port: this.cfg.port,
      password: this.cfg.password,
      db: this.cfg.db,
      tls: this.cfg.tls ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    this.client.on('error', (err) =>
      this.logger.warn(`Redis error: ${err.message}`),
    );
    try {
      await this.client.connect();
      this.logger.log(`Redis connected at ${this.cfg.host}:${this.cfg.port}`);
    } catch (err) {
      this.logger.error(
        `Redis connect failed; degrading to in-memory cache: ${(err as Error).message}`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
    this.client = null;
    this.memory.clear();
  }

  isRedis(): boolean {
    return this.client !== null;
  }

  getRedisClient(): Redis | null {
    return this.client;
  }

  defaultTtl(): number {
    return this.cfg.defaultTtlSeconds;
  }

  dashboardTtl(): number {
    return this.cfg.dashboardTtlSeconds;
  }

  reportTtl(): number {
    return this.cfg.reportTtlSeconds;
  }

  /**
   * Read a JSON value if cached, otherwise compute via `producer`, store
   * with the given TTL, and return. Errors thrown by `producer` propagate
   * unchanged — we don't poison the cache with rejected promises.
   */
  async wrap<T>(
    key: string,
    ttlSeconds: number,
    producer: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await producer();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async get<T>(key: string): Promise<T | null> {
    const k = this.keyPrefix + key;
    if (this.client) {
      try {
        const raw = await this.client.get(k);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch (err) {
        this.logger.warn(`cache.get failed for ${k}: ${(err as Error).message}`);
        return null;
      }
    }
    const entry = this.memory.get(k);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.memory.delete(k);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const k = this.keyPrefix + key;
    const payload = JSON.stringify(value);
    if (this.client) {
      try {
        await this.client.set(k, payload, 'EX', ttlSeconds);
      } catch (err) {
        this.logger.warn(`cache.set failed for ${k}: ${(err as Error).message}`);
      }
      return;
    }
    if (this.memory.size >= this.memoryCap) {
      // crude LRU: drop the oldest insertion. Map preserves insertion order.
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(k, {
      value: payload,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    const k = this.keyPrefix + key;
    if (this.client) {
      await this.client.del(k).catch(() => undefined);
      return;
    }
    this.memory.delete(k);
  }

  /**
   * Bulk-invalidate every key matching a prefix. Used when an upstream
   * event invalidates a class of cached values (e.g. deleting a sales
   * order should invalidate every "sales-report:*" entry).
   *
   * On Redis we use SCAN (not KEYS) to avoid blocking; on the in-memory
   * fallback we just iterate the Map.
   */
  async delByPrefix(prefix: string): Promise<number> {
    const fullPrefix = this.keyPrefix + prefix;
    if (this.client) {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${fullPrefix}*`,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          removed += await this.client.del(...keys);
        }
      } while (cursor !== '0');
      return removed;
    }
    let removed = 0;
    for (const k of Array.from(this.memory.keys())) {
      if (k.startsWith(fullPrefix)) {
        this.memory.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}
