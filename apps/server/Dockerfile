# Synapse coordination server — the one always-on piece a team "ships to a
# machine." The per-dev daemon stays a local CLI (it needs the working tree),
# so this image ships only the server.
#
# Build from the repo ROOT so the whole monorepo is in context:
#   docker build -f apps/server/Dockerfile -t synapse-server .
# (docker-compose.yml at the repo root does this for you.)

# ---- builder: full toolchain so better-sqlite3's native binding compiles ----
FROM node:20 AS builder
WORKDIR /app

# Install with the lockfile against the full workspace, then build only the
# server workspace. Its tsconfig project references pull in @synapse/protocol and
# @synapse/conflict-engine, so we get a minimal server build without the CLI or
# the Python/tree-sitter analyzers.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN npm ci
RUN npm run build --workspace @synapse/server

# ---- runtime: slim image, same Debian base so the native binding matches ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the resolved dependency tree (root node_modules carries better-sqlite3's
# compiled binding, ws, and the @synapse/* workspace symlinks) plus the built
# dist of the server and the two packages those symlinks point at.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/conflict-engine/package.json ./packages/conflict-engine/package.json
COPY --from=builder /app/packages/conflict-engine/dist ./packages/conflict-engine/dist

# Pass-through configuration (see .env.example):
#   SYNAPSE_SERVER_PORT            listen port (default 4010)
#   SYNAPSE_MASTER_SECRET          enables project-key auth + tenancy
#   SYNAPSE_AUTH_TOKEN             legacy shared-token auth (alternative)
#   SYNAPSE_DB_PATH                durable SQLite state (mount a volume)
#   SYNAPSE_GITHUB_WEBHOOK_SECRET  optional webhook HMAC
EXPOSE 4010
CMD ["node", "apps/server/dist/index.js"]
