#!/usr/bin/env bash
#
# Task #1840 — Schema-Migration für Nicht-Replit-Deployments (Hetzner/Coolify).
#
# Gedacht als Coolify **Pre-Deploy-Command**: `bash scripts/migrate.sh`.
#
# Drift-Sicherheit (bewusst): Die drizzle-kit-Version wird NICHT hartkodiert,
# sondern EXAKT aus `package-lock.json` gelesen — also exakt die Version, gegen
# die das Schema getestet wurde. `npx --yes drizzle-kit@latest` ist verboten:
# ein Versions-Drift im Migrationstool auf echten Abrechnungs-/Patientendaten
# ist ein reales Risiko.
#
# `drizzle.config.ts` liest `DATABASE_URL` und nutzt eine direkte pg-TCP-
# Verbindung (kein Neon-WebSocket-Proxy nötig).
#
# Argumente werden an drizzle-kit durchgereicht. `--force` wendet Änderungen
# nicht-interaktiv an — INKLUSIVE potenziell destruktiver (Spalten-Drops).
# Bewusst KEIN Default: der Aufrufer/Coolify entscheidet nach Review des
# Schema-Diffs explizit, ob `--force` gesetzt wird.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[migrate] FEHLER: DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi

VERSION="$(node -e "process.stdout.write(require('./package-lock.json').packages['node_modules/drizzle-kit'].version)")"
if [ -z "$VERSION" ]; then
  echo "[migrate] FEHLER: drizzle-kit-Version nicht in package-lock.json gefunden." >&2
  exit 1
fi

echo "[migrate] drizzle-kit@${VERSION} push (Version gepinnt aus package-lock.json)"
exec npx --yes "drizzle-kit@${VERSION}" push "$@"
