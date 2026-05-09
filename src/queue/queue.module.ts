import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { QUEUE_INSTANCES, QueueInstances, QueueService } from './queue.service';
import { QUEUE_NAMES } from './queue.constants';
import type { RedisConfig } from '../config/redis.config';

/**
 * Builds a connection-options object compatible with BullMQ. Exposed for
 * worker bootstrap (src/worker.ts) which wants the same connection.
 */
export function buildBullConnection(cfg: RedisConfig): {
  host: string;
  port: number;
  password?: string;
  db: number;
  tls?: Record<string, never>;
} | null {
  if (!cfg.enabled || !cfg.host) return null;
  return {
    host: cfg.host,
    port: cfg.port,
    password: cfg.password,
    db: cfg.db,
    ...(cfg.tls ? { tls: {} } : {}),
  };
}

/**
 * Global queue module. Provides {@link QueueService} for producing jobs;
 * registers BullMQ Queues only when Redis is enabled. Workers (the
 * processors) are NOT auto-started here — see WORKER_MODE in
 * src/worker.ts and src/queue/workers.ts.
 */
@Global()
@Module({
  providers: [
    QueueService,
    {
      provide: QUEUE_INSTANCES,
      useFactory: (config: ConfigService): QueueInstances => {
        const cfg = config.getOrThrow<RedisConfig>('redis');
        const conn = buildBullConnection(cfg);
        if (!conn) return {};
        const make = (name: string): Queue =>
          new Queue(name, { connection: conn });
        return {
          [QUEUE_NAMES.notification]: make(QUEUE_NAMES.notification),
          [QUEUE_NAMES.automation]: make(QUEUE_NAMES.automation),
          [QUEUE_NAMES.reporting]: make(QUEUE_NAMES.reporting),
        };
      },
      inject: [ConfigService],
    },
  ],
  exports: [QueueService],
})
export class QueueModule implements OnModuleInit {
  private readonly logger = new Logger(QueueModule.name);
  constructor(private readonly queue: QueueService) {}

  onModuleInit(): void {
    if (!this.queue.isEnabled()) {
      this.logger.log('Queue running in no-op mode (REDIS_HOST unset)');
    } else {
      this.logger.log(
        'Queue ready (notification, automation, reporting backed by Redis)',
      );
    }
  }
}
