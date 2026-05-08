import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootTestApp } from './boot';

/**
 * Auth login flow.
 *
 * Why the focus on validation paths? Login is the gatekeeper for every
 * other flow — exercising it end-to-end gives us confidence that the
 * pipe → controller → strategy → response-envelope chain is wired
 * correctly. Successful login is intentionally NOT asserted here,
 * because it requires DB seed credentials which the suite doesn't
 * own; integration runs in CI assert that path via
 * scripts/smoke-clinical-flow.ts.
 */
describe('Auth login (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects empty body with 400 + validation details', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.path).toBe('/api/v1/auth/login');
  });

  it('rejects invalid email format', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'whatever123' })
      .expect(400);

    expect(res.body.error.details.join(',')).toMatch(/email/i);
  });

  it('rejects unknown email with 401 (no info leak)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'definitely-not-a-real-user@example.com',
        password: 'correct-horse-battery',
      })
      .expect(401);

    expect(res.body.success).toBe(false);
    // Don't assert message content beyond a basic shape — the wording is
    // a UX detail that may evolve, but the envelope shape must not.
    expect(typeof res.body.error.message).toBe('string');
  });
});
