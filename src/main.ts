import 'reflect-metadata';
import {
  Logger,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/app.config';
import { startWorkers } from './queue/workers';

/**
 * HTTP entrypoint. Boot order is intentionally ordered:
 *
 *  1. createApp(bufferLogs)        — capture early logs in pino buffer.
 *  2. ConfigService                — driven by Joi-validated env, fail-fast
 *                                    if anything is wrong.
 *  3. helmet, cors, compression    — security/perf middleware first.
 *  4. global pipes / interceptors / filters already registered via DI.
 *  5. global prefix + URI versioning.
 *  6. Swagger.
 *  7. enableShutdownHooks          — Prisma/Redis/BullMQ disconnects on SIGTERM.
 *  8. Optional in-process workers  — if WORKER_MODE=embedded run BullMQ
 *                                    consumers in this same process.
 *  9. listen.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const appCfg = config.getOrThrow<AppConfig>('app');

  app.use(
    helmet({
      contentSecurityPolicy: appCfg.isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(compression());
  app.enableCors({
    origin: appCfg.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-request-id',
      'x-correlation-id',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Mount everything at /api/v1, leaving /health/* and /api/docs at root.
  // URI versioning keeps the door open for v2 additions without breaking
  // existing consumers — new controllers just declare @Controller({ version: '2' }).
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const docs = new DocumentBuilder()
    .setTitle('Reverie Desk API')
    .setDescription('Production API for the Reverie Desk clinic ERP backend')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        in: 'header',
      },
      'bearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, docs);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
    },
  });

  app.enableShutdownHooks();

  // Optional embedded worker mode — useful in dev or single-host deploys.
  // Production should run `npm run worker` in a separate process so a
  // long-running job can't slow HTTP traffic.
  if (process.env.WORKER_MODE === 'embedded') {
    const workers = startWorkers(app);
    if (workers.length > 0) {
      logger.log(`Embedded BullMQ workers started (${workers.length})`);
    }
  }

  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });

  await app.listen(appCfg.port || 3000);
  logger.log(
    `Reverie Desk API listening on :${appCfg.port} [${appCfg.env}]  →  /api/v1  •  /api/docs  •  /health`,
  );
}

void bootstrap();
