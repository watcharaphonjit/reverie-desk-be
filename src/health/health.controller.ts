import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Health endpoints. Three deliberately separate probes:
 *
 *   /health/live    — liveness: process is up. No external deps. Used
 *                     by Kubernetes to decide whether to restart.
 *   /health/ready   — readiness: every external dependency required to
 *                     serve traffic is healthy (Postgres, Redis when
 *                     enabled). Used by load balancers.
 *   /health         — combined view, returns the union for observability.
 */
@ApiTags('health')
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get('live')
  @HealthCheck()
  liveness(): HealthCheckResult {
    return {
      status: 'ok',
      info: { app: { status: 'up' } },
      error: {},
      details: { app: { status: 'up' } },
    };
  }

  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db(), () => this.redis()]);
  }

  @Get()
  @HealthCheck()
  full(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db(), () => this.redis()]);
  }

  private async db(): Promise<HealthIndicatorResult> {
    const probe = this.indicator.check('database');
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return probe.up();
    } catch (err) {
      return probe.down({ message: (err as Error).message });
    }
  }

  private async redis(): Promise<HealthIndicatorResult> {
    const probe = this.indicator.check('redis');
    if (!this.cache.isRedis()) {
      // Soft-OK: marked as "skipped" when not configured. Operators can
      // distinguish real outages from "no Redis configured" via details.
      return probe.up({ mode: 'skipped', reason: 'REDIS_HOST not set' });
    }
    try {
      const client = this.cache.getRedisClient();
      const reply = await client?.ping();
      return reply === 'PONG'
        ? probe.up()
        : probe.down({ reply: reply ?? null });
    } catch (err) {
      return probe.down({ message: (err as Error).message });
    }
  }
}
