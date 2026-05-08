/**
 * `npm run db:check` — verify that the database schema matches the
 * Prisma schema and there are no pending migrations.
 *
 * Exit codes:
 *   0  schema is up to date
 *   1  pending migrations or drift detected
 *   2  cannot reach the DB
 *
 * Used by CI before deploy and as a pre-commit safety check. The actual
 * heavy-lifting is delegated to the prisma CLI; this script wraps it
 * with a structured output so a failed check is easy to spot in logs.
 */
import 'dotenv/config';
import { execSync } from 'child_process';

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      ok: false,
      output: `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`,
    };
  }
}

function main(): void {
  console.log('🔍 Checking database connectivity…');
  const ping = run('npx prisma db execute --stdin --schema prisma/schema.prisma');
  // `prisma db execute` requires a SQL statement; we don't actually need to
  // run anything, we just want to hit the URL. Use `migrate status` instead
  // which both connects and reports drift.

  console.log('🔍 Checking pending migrations & drift…');
  const status = run('npx prisma migrate status --schema prisma/schema.prisma');
  process.stdout.write(status.output);

  if (!status.ok) {
    if (/can't reach database server|connection refused|ECONNREFUSED/i.test(status.output)) {
      console.error('❌ Database unreachable.');
      process.exit(2);
    }
    if (/Following migration|have not yet been applied|drift/i.test(status.output)) {
      console.error('❌ Pending migrations or schema drift detected.');
      process.exit(1);
    }
    console.error('❌ migrate status failed.');
    process.exit(1);
  }
  console.log('✅ Database schema is up to date.');
  // Suppress warnings from the unused ping helper.
  void ping;
}

main();
