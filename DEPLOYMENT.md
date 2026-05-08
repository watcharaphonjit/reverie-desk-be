# Reverie Desk Backend — Deployment Guide

Production-grade NestJS + Prisma + Postgres + Redis service for the Reverie Desk clinic ERP. This document covers everything required to take the codebase from a fresh checkout to a running, monitored production deployment.

---

## 1. Architecture overview

```
                ┌──────────────────────────┐
   client ───►  │  API container (Node.js) │  ──► Postgres (managed)
                │  - HTTP /api/v1/...      │  ──► Redis (managed)
                │  - /health/* probes      │
                │  - Pino structured logs  │
                └──────────────────────────┘
                            ▲
                            │ same image, different CMD
                            │
                ┌──────────────────────────┐
                │  Worker container        │
                │  - BullMQ consumers      │
                │    notification, automation, reporting
                └──────────────────────────┘
```

The API and worker share the same Docker image (`Dockerfile`, target `prod`). They're separated at runtime so a slow background job cannot starve HTTP traffic.

---

## 2. Required environment variables

Every variable below is validated by Joi at boot. Missing/malformed values fail fast — the process exits before binding the HTTP port. See `.env.example` for the canonical template.

| Variable | Required | Default | Notes |
|---|:-:|---|---|
| `NODE_ENV` | yes | `development` | `development` / `staging` / `production` / `test` |
| `PORT` | no | `3000` | |
| `DATABASE_URL` | yes | — | Postgres URI; `postgresql://` or `postgres://` |
| `JWT_SECRET` | yes | — | Min 16 chars; rotate on incident |
| `JWT_EXPIRES_IN` | yes | — | e.g. `12h`, `7d` |
| `LOG_LEVEL` | no | `info` | `silent` in tests; `info` or `warn` in prod |
| `REDIS_HOST` | yes (prod) | — | When unset, cache and queue degrade to in-process no-ops |
| `REDIS_PORT` | no | `6379` | |
| `REDIS_PASSWORD` | no | — | |
| `REDIS_DB` | no | `0` | |
| `REDIS_TLS` | no | `false` | |
| `CACHE_TTL_SECONDS` | no | `60` | Default cache TTL |
| `CACHE_DASHBOARD_TTL_SECONDS` | no | `30` | |
| `CACHE_REPORT_TTL_SECONDS` | no | `300` | |
| `THROTTLE_DEFAULT_LIMIT` | no | `100` | Per-IP default; req/min |
| `THROTTLE_AUTH_LIMIT` | no | `5` | `/auth/login`; req/min |
| `THROTTLE_ADMIN_LIMIT` | no | `50` | `/automation/*`, `/audit/*`; req/min |
| `THROTTLE_TTL_MS` | no | `60000` | Window length |
| `THROTTLE_DISABLED` | no | `false` | Set `true` for CI/smoke; production must be `false` |
| `LOW_STOCK_THRESHOLD` | no | `5` | |
| `EXPIRY_ALERT_DAYS` | no | `30` | |
| `LEAD_FOLLOWUP_HOURS` | no | `48` | |
| `APPOINTMENT_REMINDER_WINDOW_HOURS` | no | `24` | |
| `WALLET_EXPIRY_NOTICE_DAYS` | no | `7` | |
| `AUTOMATION_DISABLED` | no | `''` | Comma-separated rule codes to disable at boot |
| `CORS_ORIGINS` | no | `*` | Comma-separated origins or `*` |
| `WORKER_MODE` | no | — | `embedded` runs workers in-process; leave unset in prod |

---

## 3. First-time setup

```bash
# 1. dependencies
npm ci

# 2. compile typecheck (catches schema drift early)
npx tsc --noEmit

# 3. database
cp .env.example .env       # then edit DATABASE_URL & JWT_SECRET
npm run db:check           # verifies connectivity & schema
npx prisma migrate deploy  # apply pending migrations
npm run seed:minimal       # roles, permissions, default admin

# 4. boot
npm run start:prod
```

Default admin credentials seeded by `seed:minimal`:
- email: `admin@reverie.local`
- password: `Admin123!`

Rotate immediately on any deploy.

---

## 4. Migration flow

| Action | Command |
|---|---|
| Inspect schema state | `npm run db:check` |
| Generate a new migration locally | `npx prisma migrate dev --name <slug>` |
| Apply migrations in CI/prod | `npm run db:migrate` (alias for `prisma migrate deploy`) |
| Backup before destructive change | `npm run db:backup` |

The Docker image runs `prisma migrate deploy` automatically on startup (see `docker-compose.yml`'s `command:` block). For zero-downtime deployments, prefer running migrations as a pre-deploy job instead.

---

## 5. Running with Docker

### Local stack (Postgres + Redis + API + worker)

```bash
docker compose up --build -d
docker compose logs -f api worker
```

The compose file ships:
- Postgres 16 (data volume `postgres-data`)
- Redis 7 with AOF persistence (data volume `redis-data`)
- API container exposing `localhost:3000`
- Worker container running BullMQ consumers

### Production overlay

```bash
export IMAGE_TAG=$(git rev-parse --short HEAD)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The prod overlay disables the bundled Postgres/Redis (production should use managed services), pulls the API image from the registry, and applies CPU/memory limits.

---

## 6. Scaling

| Component | Scaling strategy |
|---|---|
| API | Stateless. Run N replicas behind a load balancer. JWTs are self-contained; no shared session state. |
| Workers | Scale by queue throughput. Set `WORKER_REPLICAS` in compose, or run more worker pods. |
| Postgres | Vertical first (CPU/RAM), then read-replicas for reporting. The reports module already uses `aggregate`/`groupBy`. |
| Redis | Single primary is sufficient up to ~50k req/min. Use ElastiCache or Upstash for managed HA. |

---

## 7. Observability

- **Structured logs**: every request emits a JSON line with `correlationId`, method, URL, status, response time. Honours an inbound `x-request-id` header.
- **Health probes**: `/health/live` (process), `/health/ready` (DB + Redis), `/health` (combined). Use `/health/live` for liveness, `/health/ready` for readiness.
- **Swagger**: `/api/docs` (interactive UI) and `/api/docs-json` (raw OpenAPI).
- **Error envelope**: every failed response has `{ success:false, error:{ code, message, details, correlationId, ... } }`. The `code` field is stable and clients can branch on it.

---

## 8. Background jobs

The system has three queues backed by BullMQ:

| Queue | Producer | Consumer | Purpose |
|---|---|---|---|
| `notification` | NotificationsService.notify (when async) | dispatchById | Email / SMS / IN_APP fan-out |
| `automation` | AutomationService.run | run-rule | Rule executions enqueued from cron / triggers |
| `reporting` | future | precompute | Report precomputation / cache warming |

Workers run in a separate process via `npm run worker`. In small deployments you can co-locate them by setting `WORKER_MODE=embedded` on the API process.

---

## 9. Security checklist

- ☑️ Helmet on every response (`x-content-type-options`, `x-frame-options`, etc.).
- ☑️ Compression (`gzip`).
- ☑️ CORS allowlist via `CORS_ORIGINS` (default `*` for dev, lock down in prod).
- ☑️ Throttle: 5 req/min on `/auth/login`, 50 req/min on admin routes, 100 req/min global default.
- ☑️ Validation pipe with `whitelist + forbidNonWhitelisted` strips unknown fields.
- ☑️ Sensitive log fields redacted (`Authorization`, `Cookie`, `password`, `token`).
- ☑️ JWT_SECRET length validated by Joi (≥16 chars).
- ☐ Rotate JWT_SECRET on incident (not automated; runbook below).

---

## 10. Runbooks

### Rotate `JWT_SECRET`
1. Set the new secret on every API/worker pod simultaneously.
2. Rolling-restart. All sessions are invalidated; clients must re-login.

### Disable an automation rule without redeploying
1. `PATCH /api/v1/automation/rules/:code` with `{ enabled: false }` (requires `AUTOMATION_MANAGE` permission).
2. To make it permanent across restarts, add the code to `AUTOMATION_DISABLED` env.

### Investigate a 500 in production
1. Grab the `correlationId` from the response envelope.
2. `kubectl logs deploy/api -c api | grep <correlationId>` (or your log aggregator equivalent).
3. The unhandled-error path also logs the full stack at `error` level.

### Manual backfill / report precomputation
1. SSH into a worker pod (or run a one-off): `npm run worker`.
2. Use `redis-cli xadd` against the relevant BullMQ stream — or call the producing API with a forced trigger.

---

## 11. Smoke tests

Verify a fresh deploy against the running API:

```bash
export BASE_URL=http://localhost:3000/api/v1
export THROTTLE_DISABLED=true   # CI / smoke only
npm run test:smoke              # runs all six end-to-end smokes
```

Expected output:
```
ALL CLINICAL-FLOW SMOKE CHECKS PASSED
ALL BRANCH-STOCK-SALES SMOKE CHECKS PASSED
✅ commission + refund + wallet smoke OK
ALL COMMISSION-RULES SMOKE CHECKS PASSED
✅ reports + dashboard + audit smoke OK
✅ notifications + automation smoke OK
```

---

## 12. Known limitations & TODOs

- The notification email/SMS providers are stubs; wire to a real transport (SES, Twilio, etc.) before production rollout.
- Bull Board (queue UI) is not yet exposed. Recommended addition for ops visibility.
- `scripts/db-backup.ts` requires `pg_dump` on PATH and Bash; rewrite as a workflow if running on Windows servers.
- The `audit-logs` table is unbounded; add a partition or archival job before you cross ~50M rows.
