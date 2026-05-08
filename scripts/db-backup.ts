/**
 * `npm run db:backup` — produce a pg_dump of DATABASE_URL.
 *
 * Output:  ./backups/reverie-desk-<ISO>.sql.gz
 *
 * This is a wrapper around the system `pg_dump` (must be on PATH). It
 * deliberately uses --no-owner --no-acl so the dump can be restored to
 * a different role without privilege churn.
 *
 * Production should normally rely on the managed-DB provider's
 * snapshots; this script is for local snapshots before risky
 * migrations.
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace(/Z$/, '');
}

function main(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }
  const outDir = join(process.cwd(), 'backups');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const target = join(outDir, `reverie-desk-${timestamp()}.sql.gz`);

  // pg_dump auto-detects the URL via `-d "$DATABASE_URL"`. We pipe to gzip
  // for a 5-10x size reduction; the .gz is what restore scripts expect.
  const cmd = `pg_dump --no-owner --no-acl --format=plain "${url}" | gzip > "${target}"`;
  console.log(`📦 Dumping → ${target}`);
  try {
    execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
    console.log(`✅ Backup written: ${target}`);
  } catch (err) {
    console.error(`❌ Backup failed: ${(err as Error).message}`);
    console.error(
      'Hint: pg_dump must be on PATH and DATABASE_URL must reference a reachable Postgres server.',
    );
    process.exit(1);
  }
}

main();
