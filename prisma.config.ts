import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * `prisma generate` (run at Docker build time, before Railway injects
 * runtime env vars) doesn't actually need a live datasource — only the
 * schema. Prisma's `env()` helper, however, throws `PrismaConfigEnvError`
 * the moment `DATABASE_URL` is unset, which kills the build image.
 *
 * Reading from `process.env` directly avoids that pitfall: the value is
 * resolved at config-load time and falls back to an empty string when
 * missing. The runtime `prisma migrate deploy` step in the container's
 * default CMD has the real `DATABASE_URL` available and works as usual.
 *
 * The `datasource` block in `prisma/schema.prisma` still uses
 * `env("DATABASE_URL")`, so the Prisma client picks up the actual URL
 * from the runtime environment — this config file only feeds CLI commands.
 */
export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'npx tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
