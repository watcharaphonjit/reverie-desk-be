/**
 * Standalone worker process. Starts a Nest application context (no HTTP
 * listener) and registers the BullMQ workers — this is what runs in the
 * worker container alongside the API.
 *
 * Boot order:
 *   1. NestFactory.createApplicationContext() so we get the same DI
 *      graph as the API (Prisma, Notifications, Automation, etc).
 *   2. enableShutdownHooks so SIGTERM cleanly closes Prisma, Redis, BullMQ.
 *   3. startWorkers() wires the actual BullMQ Worker instances.
 *
 * Run with `npm run worker`.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { startWorkers } from './queue/workers';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();

  const workers: Worker[] = startWorkers(app);
  if (workers.length === 0) {
    logger.error('No workers started — is REDIS_HOST configured?');
    await app.close();
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down workers…`);
    await Promise.all(workers.map((w) => w.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log('Worker process ready');
}

void bootstrap();
