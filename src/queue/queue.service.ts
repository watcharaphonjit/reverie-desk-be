import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, JobsOptions } from 'bullmq';
import {
  AutomationJobData,
  NotificationJobData,
  QUEUE_NAMES,
  QueueName,
  ReportingJobData,
} from './queue.constants';
import type { RedisConfig } from '../config/redis.config';

export const QUEUE_INSTANCES = 'QUEUE_INSTANCES';
export type QueueInstances = Partial<Record<QueueName, Queue>>;

/**
 * High-level queue producer. When Redis is configured the BullMQ Queues
 * are wired up at module init and jobs are enqueued normally. Without
 * Redis the queues are absent and the producer logs+drops the job — this
 * keeps local dev unblocked without dragging Redis into every test.
 *
 * Workers (the consumers) live in src/queue/processors and run either in
 * the API process (small deployments) or as a dedicated `npm run worker`
 * process (recommended in production — see WORKER_MODE env).
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly redisEnabled: boolean;

  constructor(
    config: ConfigService,
    @Optional()
    @Inject(QUEUE_INSTANCES)
    private readonly queues: QueueInstances = {},
  ) {
    this.redisEnabled = config.getOrThrow<RedisConfig>('redis').enabled;
  }

  isEnabled(): boolean {
    return this.redisEnabled;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Object.values(this.queues).map((q) => q?.close().catch(() => undefined)),
    );
  }

  enqueueNotification(
    data: NotificationJobData,
    opts: JobsOptions = {},
  ): Promise<void> {
    return this.add(QUEUE_NAMES.notification, 'dispatch', data, opts);
  }

  enqueueAutomation(
    data: AutomationJobData,
    opts: JobsOptions = {},
  ): Promise<void> {
    return this.add(QUEUE_NAMES.automation, 'run-rule', data, opts);
  }

  enqueueReport(data: ReportingJobData, opts: JobsOptions = {}): Promise<void> {
    return this.add(QUEUE_NAMES.reporting, 'precompute', data, opts);
  }

  private async add(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    opts: JobsOptions,
  ): Promise<void> {
    const queue = this.queues[queueName];
    if (!queue) {
      // Soft no-op so consumers/integrations that pre-date Redis don't break.
      this.logger.debug(
        `[no-redis] dropped ${queueName}.${jobName} job ${JSON.stringify(data).slice(0, 120)}`,
      );
      return;
    }
    await queue.add(jobName, data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
      ...opts,
    });
  }
}
