# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Task #1840 — Container-Image für den Replit-Exit (Hetzner/Coolify).
#
# Multi-Stage:
#   builder  – volle Deps + Build (Vite-Client + esbuild-Server-Bundle).
#              Native Module (bcrypt) werden hier EINMAL gebaut und danach auf
#              prod-only geprunt; der Runner kopiert dieses node_modules und
#              braucht daher weder npm ci noch Build-Tools.
#   runner   – schlanke Laufzeit: System-Chromium (puppeteer-core), non-root,
#              NODE_ENV=production, lauscht auf 0.0.0.0:$PORT.
#
# Migrationen laufen NICHT beim Boot, sondern als Coolify Pre-Deploy-Command
# (`bash scripts/migrate.sh`). Deploys baut Coolify bei Push — nie auf dem
# Server. Siehe CLAUDE.md.
# ---------------------------------------------------------------------------

# ---- Stage 1: builder ----
FROM node:20-slim AS builder
WORKDIR /app

# Build-Tools nur für native Module (bcrypt). Bleiben NICHT im finalen Image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Deterministische Installation zuerst (Layer-Cache: nur bei Lockfile-Änderung neu).
# Der postinstall-Hook (`scripts/normalize-lockfile.mjs`, reine Node-Bordmittel,
# idempotent) muss VOR `npm ci` vorliegen — sonst bricht npm mit "Cannot find
# module" ab.
COPY package.json package-lock.json ./
COPY scripts/normalize-lockfile.mjs ./scripts/normalize-lockfile.mjs
RUN npm ci

# Quellcode + Build.
COPY . .
RUN npm run build

# node_modules auf Produktions-Deps reduzieren (native Module bleiben gebaut).
RUN npm prune --omit=dev

# ---- Stage 2: runner ----
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=5000

# System-Chromium + Fonts für die server-seitige PDF-Generierung
# (puppeteer-core löst /usr/bin/chromium über CHROMIUM_PATH/Fallback auf).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Geprunte Prod-node_modules + Build-Artefakte aus dem Builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Für den Migrations-Pre-Deploy (`bash scripts/migrate.sh`):
#   - package-lock.json: migrate.sh liest die gepinnte drizzle-kit-Version daraus
#   - drizzle.config.ts + shared/ + migrations/: Schema-Quelle für drizzle-kit
COPY package.json package-lock.json drizzle.config.ts ./
COPY shared ./shared
COPY migrations ./migrations
COPY scripts/migrate.sh ./scripts/migrate.sh

# non-root Laufzeit; /data als Mountpoint für den lokalen Storage-Treiber.
RUN groupadd --system app \
  && useradd --system --gid app --home-dir /app app \
  && mkdir -p /data \
  && chown -R app:app /app /data
USER app

VOLUME ["/data"]
EXPOSE 5000
CMD ["node", "dist/index.cjs"]
