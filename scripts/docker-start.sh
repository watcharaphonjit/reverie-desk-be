#!/bin/sh
# Production container entrypoint.
#
# Order of operations:
#   1. Validate DATABASE_URL is reachable (clear error if missing — the
#      previous behaviour bubbled up a cryptic
#      "datasource.url property is required" deep in the Prisma CLI).
#   2. Apply pending Prisma migrations (idempotent; advisory-locked
#      across replicas, so concurrent boots are safe).
#   3. `exec` the Node process so PID 1 is Node and SIGTERM reaches
#      the graceful shutdown hooks.
#
# Skipping migrations:
#   Set SKIP_PRISMA_MIGRATE=1 to bypass step 2 — useful when running
#   migrations as a one-off Railway job before the deploy.

set -e

if [ -z "${DATABASE_URL:-}" ]; then
  cat >&2 <<'EOF'
FATAL: DATABASE_URL environment variable is not set.

This container needs DATABASE_URL at runtime. On Railway:

  1. Open this service's "Variables" tab.
  2. Add a reference variable:
       DATABASE_URL = ${{Postgres.DATABASE_URL}}
     (replace "Postgres" with the actual name of your Postgres plugin
      service if different).
  3. Redeploy.

For local Docker runs, pass it explicitly:
  docker run -e DATABASE_URL=postgresql://... <image>

EOF
  exit 1
fi

if [ "${SKIP_PRISMA_MIGRATE:-0}" = "1" ] || [ "${SKIP_PRISMA_MIGRATE:-0}" = "true" ]; then
  echo "[entrypoint] SKIP_PRISMA_MIGRATE set — skipping prisma migrate deploy"
else
  echo "[entrypoint] Applying Prisma migrations..."
  npx prisma migrate deploy
fi

echo "[entrypoint] Starting API..."
exec node dist/src/main.js
