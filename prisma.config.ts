import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 changed two things that interact badly during a Docker
 * build on Railway:
 *
 *   1. The schema-level `datasource.url` is no longer supported — the
 *      connection string must come from this config file.
 *   2. If `datasource.url` is provided here, Prisma validates it at
 *      config-load time and rejects empty / missing values with
 *      `PrismaConfigEnvError` or "datasource.url property is required".
 *
 * Railway only injects env vars at runtime, so during `docker build`
 * `DATABASE_URL` is absent. To keep `prisma generate` (build) and
 * `prisma migrate deploy` (container start) both happy, we include the
 * `datasource` block conditionally:
 *
 *   - Build (`DATABASE_URL` undefined): block omitted entirely. `prisma
 *     generate` doesn't need a connection string, so it succeeds.
 *   - Runtime (`DATABASE_URL` injected by Railway): block included with
 *     the real URL. `prisma migrate deploy` connects normally.
 *
 * The application's `PrismaClient` uses `@prisma/adapter-pg` and reads
 * `DATABASE_URL` from `process.env` at runtime, independent of this file.
 */
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'npx tsx prisma/seed.ts',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
