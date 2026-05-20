#!/bin/bash
set -e

npm install --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

# Task #50: Add service_details column to invoice_line_items
psql "$DATABASE_URL" -c "ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS service_details TEXT;" 2>/dev/null || true

# Drizzle introspect kann bei Neon-Cold-Start minutenlang hängen (Task #540
# Post-Merge: 3400+ Spinner-Frames, 440s gelaufen bis Hard-Kill). Wir geben
# dem Push 60s Zeit; danach wird der nächste Merge oder ein manueller Push
# die Drift einsammeln. Idempotent: kein Schaden, wenn übersprungen.
timeout --signal=TERM --kill-after=5s 60s npm run db:push 2>/dev/null || \
  echo "[post-merge] db:push skipped/timed out — wird beim nächsten Lauf nachgeholt"
