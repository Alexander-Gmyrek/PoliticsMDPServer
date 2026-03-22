# ── Stage 1: Builder ───────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install curl for downloading legislator data at startup
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production Node deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# ── Startup script: fetches fresh legislator data then starts the MCP server ──
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Data directories (mounted as volumes — persisted across restarts) ──────────
RUN mkdir -p /data/congress/legislators /data

# ── Runtime config defaults ────────────────────────────────────────────────────
ENV NODE_ENV=production \
    CONGRESS_DATA_DIR=/data/congress \
    DB_JSON_PATH=/data/db.json \
    DB_SQLITE_PATH=/data/civics.db \
    ENABLE_DATABASE=false \
    REFRESH_LEGISLATORS_ON_START=true

# Healthcheck: confirm the compiled entry point exists
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('fs').statSync('/app/dist/index.js')" || exit 1

ENTRYPOINT ["/entrypoint.sh"]