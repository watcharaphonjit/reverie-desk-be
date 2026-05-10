# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for Reverie Desk API + worker.
# - Stage 1 (deps):   install full deps with dev for the build.
# - Stage 2 (build):  compile TS → JS, generate Prisma client.
# - Stage 3 (prod):   prod-only deps, copy compiled output, run as non-root.
#
# The same image runs both the API (default CMD) and the worker (CMD
# override `node dist/src/worker.js`) — there's no point shipping two
# images for a single Node service. compose.prod.yml shows both flavors.

ARG NODE_VERSION=22
ARG ALPINE=alpine3.20

# ─── deps ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${ALPINE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev --ignore-scripts

# ─── build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${ALPINE} AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client must be generated against the schema we ship.
RUN npx prisma generate \
 && npm run build \
 && npm prune --omit=dev

# ─── prod ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${ALPINE} AS prod
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_LOGLEVEL=warn

RUN apk add --no-cache tini openssl curl \
 && addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/package-lock.json ./package-lock.json
COPY --from=build --chown=app:app /app/scripts/docker-start.sh ./scripts/docker-start.sh
RUN chmod +x ./scripts/docker-start.sh

USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health/ready || exit 1

# Use tini so SIGTERM propagates correctly to Node and triggers the
# graceful shutdown hooks (Prisma/Redis/BullMQ disconnect).
#
# The entrypoint script:
#   - Validates DATABASE_URL is present (fails with a clear, actionable
#     message instead of the cryptic Prisma "datasource.url required").
#   - Runs `prisma migrate deploy` (idempotent, advisory-locked across
#     replicas). Set SKIP_PRISMA_MIGRATE=1 to bypass.
#   - `exec`s into Node so PID 1 is Node, not the wrapping shell.
#
# Workers override CMD to skip both validation and migration:
#     CMD ["node", "dist/src/worker.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./scripts/docker-start.sh"]
