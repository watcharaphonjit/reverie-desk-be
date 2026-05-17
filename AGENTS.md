# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

Reverie Desk is a multi-branch clinic/aesthetic-medicine ERP backend (NestJS + Prisma + PostgreSQL). See `docs/system-overview.md` for full architecture and `DEPLOYMENT.md` for operational details.

### Prerequisites

- **Node.js 22** (already available via nvm)
- **PostgreSQL 16** — must be installed and running (`sudo apt-get install -y postgresql postgresql-client && sudo pg_ctlcluster 16 main start`). Create user/db: `sudo -u postgres psql -c "CREATE USER reverie WITH PASSWORD 'reverie' CREATEDB;" && sudo -u postgres psql -c "CREATE DATABASE reverie_desk OWNER reverie;"`
- **Redis** — optional for dev. Cache falls back to in-memory LRU and queues become no-ops when `REDIS_HOST` is unset.

### Environment setup

1. Copy `.env.example` to `.env`. The defaults work for local dev (DB at `localhost:5432`, no Redis).
2. **Important**: Comment out or remove the `REDIS_HOST=` line in `.env` — an empty string fails Joi `hostname()` validation. The variable must be truly unset (not empty) for the graceful degradation to work.
3. Set `THROTTLE_DISABLED=true` in `.env` for smoke/CI runs.

### Database

- Generate Prisma client: `npx prisma generate`
- Apply migrations: `npx prisma migrate deploy`
- Seed: `npm run seed` (creates roles, permissions, branches, default admin)
- Default admin: `admin@reverie.local` / `Admin123!`

### Running services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| API (dev) | `npm run start:dev` | 3001 | Watch mode with hot-reload |
| API (prod) | `npm run start:prod` | 3000 | Requires `npm run build` first |
| Worker (dev) | `npm run worker:dev` | — | Optional; needs Redis |

### Key endpoints

- Health: `GET /api/health/live`, `GET /api/health/ready`
- Versioned API: `/api/v1/*`
- Swagger UI: `/api/docs`

### Testing

- **Unit tests**: `npm run test` (67/68 pass; 1 pre-existing failure in `auth.service.spec.ts` due to missing `AuditService` mock)
- **E2E tests**: `DATABASE_URL="postgresql://reverie:reverie@localhost:5432/reverie_desk" npm run test:e2e` (requires `DATABASE_URL` as env var)
- **Smoke tests**: `npm run test:smoke` (requires running API on port 3001)
- **Lint**: `npx eslint "{src,apps,libs,test}/**/*.ts"`
- **Build**: `npm run build`

### Gotchas

- The `HealthController` (version-neutral) is at `/api/health/*`, while `ApiHealthController` (v1) is at `/api/v1/health`.
- E2e tests require `DATABASE_URL` passed explicitly as an environment variable (not just from `.env`); the global setup checks `process.env.DATABASE_URL` directly.
- Phone numbers use Thai format validation (`+66...`).
- PostgreSQL service must be started manually after VM boot: `sudo pg_ctlcluster 16 main start`.
