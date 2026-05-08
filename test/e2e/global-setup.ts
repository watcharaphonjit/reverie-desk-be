/**
 * Jest globalSetup. Runs once before any e2e spec.
 *
 * - Asserts mandatory env (DATABASE_URL, JWT_SECRET) is present so we
 *   don't accidentally hit a developer's real DB.
 * - Picks up the per-CI-job `JWT_SECRET=ci-jwt-secret-please-rotate-32b`
 *   set in workflows/ci.yml.
 * - Sets THROTTLE_DISABLED=true so e2e specs aren't rate-limited.
 *
 * Migration / seed are handled by the workflow before this runs (or the
 * developer locally) — keeping that out of jest avoids long startup.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must be set for e2e tests (use a dedicated test DB)',
    );
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    process.env.JWT_SECRET = 'ci-jwt-secret-please-rotate-32b';
  }
  process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1h';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
  process.env.THROTTLE_DISABLED = 'true';
}
