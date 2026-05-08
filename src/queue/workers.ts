import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { AutomationService } from '../automation/automation.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { RedisConfig } from '../config/redis.config';
import { buildBullConnection } from './queue.module';
import {
  AutomationJobData,
  NotificationJobData,
  QUEUE_NAMES,
  ReportingJobData,
} from './queue.constants';

/**
 * Boot BullMQ workers against an existing Nest application context.
 *
 * This function is intentionally process-shape-agnostic: the same code
 * runs whether the workers are colocated with the HTTP server (small
 * deployments / dev) or live in a dedicated `npm run worker` process
 * created from src/worker.ts.
 *
 * Concurrency defaults are conservative — bump them via
 * NOTIFICATION_WORKER_CONCURRENCY etc. once you have observability.
 */
export function startWorkers(app: INestApplicationContext): Worker[] {
  const logger = new Logger('Workers');
  const config = app.get(ConfigService);
  const redis = config.getOrThrow<RedisConfig>('redis');
  const conn = buildBullConnection(redis);
  if (!conn) {
    logger.warn('REDIS_HOST not set — workers will not start');
    return [];
  }

  const notifications = app.get(NotificationsService);
  const automation = app.get(AutomationService);

  const notifWorker = new Worker<NotificationJobData>(
    QUEUE_NAMES.notification,
    async (job) => {
      const { notificationId, channel } = job.data;
      logger.log(`notification:${channel} ${notificationId}`);
      // The actual channel dispatch happens via NotificationsService when
      // the in-process notify() is called. This worker exists for the
      // future async path: enqueue → worker reads DB row → channel send.
      await notifications.dispatchById(notificationId);
    },
    {
      connection: conn,
      concurrency: Number(process.env.NOTIFICATION_WORKER_CONCURRENCY ?? 5),
    },
  );

  const autoWorker = new Worker<AutomationJobData>(
    QUEUE_NAMES.automation,
    async (job) => {
      logger.log(`automation:${job.data.ruleCode}`);
      await automation.run(job.data.ruleCode);
    },
    {
      connection: conn,
      concurrency: Number(process.env.AUTOMATION_WORKER_CONCURRENCY ?? 2),
    },
  );

  const reportWorker = new Worker<ReportingJobData>(
    QUEUE_NAMES.reporting,
    async (job) => {
      // Stub for report precomputation. The real implementation will pull
      // from ReportsService and warm the cache; for now we just log so the
      // queue surface is wired end-to-end.
      logger.log(
        `reporting:${job.data.reportType} (cacheKey=${job.data.cacheKey ?? 'none'})`,
      );
    },
    {
      connection: conn,
      concurrency: Number(process.env.REPORTING_WORKER_CONCURRENCY ?? 2),
    },
  );

  for (const w of [notifWorker, autoWorker, reportWorker]) {
    w.on('failed', (job, err) =>
      logger.error(
        `Worker job ${job?.queueName}.${job?.name} failed: ${err.message}`,
      ),
    );
    w.on('error', (err) =>
      logger.error(`Worker error: ${err.message}`),
    );
  }

  logger.log('BullMQ workers started: notification, automation, reporting');
  return [notifWorker, autoWorker, reportWorker];
}
