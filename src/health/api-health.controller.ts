import { Controller, Get } from '@nestjs/common';
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

@ApiTags('health')
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class ApiHealthController {
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
