import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootTestApp } from './boot';

/**
 * Health endpoint smoke. Cheap, fast, and validates that:
 *   - global prefix exclusion works for /health
 *   - liveness/readiness payloads match the documented shape
 *   - the response envelope interceptor wraps the body
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns 200 with {success,data:{status:"ok"}}', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 'ok' },
    });
  });

  it('GET /health/ready returns 200 and reports each indicator', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.details).toHaveProperty('database');
    expect(res.body.data.details).toHaveProperty('redis');
  });
});
