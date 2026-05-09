import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';

/**
 * Boot a real Nest application configured the same way main.ts does
 * for HTTP — global pipes, filters, prefix, versioning. Returned app
 * exposes `getHttpServer()` which Supertest binds against.
 *
 * NOTE: e2e specs MUST close the app in afterAll() to release the
 * Postgres connection pool and BullMQ queues.
 */
export async function bootTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Filter and interceptor are also wired via APP_FILTER/APP_INTERCEPTOR
  // in AppModule, but explicit registration here keeps the e2e harness
  // robust to refactors of that wiring.
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.setGlobalPrefix('api', { exclude: ['health', 'health/(.*)'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  await app.init();
  return app;
}
