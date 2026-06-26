#!/usr/bin/env bash
#
# backup-dev-db.sh — Pre-Phase-Backup der langlebigen DEV-Postgres-DB (DATABASE_URL).
#
# Zweck (Task #1239):
#   Vor jeder Vereinfachungs-Phase (und automatisch vor jedem Dev-DB-Reseed)
#   einen überprüfbaren Snapshot der Dev-DB ziehen, sodass ein Rückrollpunkt
#   existiert. Hält automatisch die letzten 5 Backups PRO FORMAT vor (ältere
#   werden gelöscht).
#
#   NICHT für Produktion. Prod-Backups laufen über scripts/backup-prod-db.sh +
#   docs/pre-publish-backup-runbook.md. Dieses Skript verweigert die Ausführung,
#   wenn es nach Produktion aussieht.
#
# Voraussetzungen:
#   - pg_dump (PostgreSQL Client 16+) im PATH
#   - DATABASE_URL gesetzt (Dev-DB-Connection-String)
#
# Optionale Umgebungsvariablen:
#   - BACKUP_DIR   (Default: tmp/db-backups/dev)
#   - BACKUP_LABEL (Default: leer; wird Teil des Dateinamens, z.B. -pre-phase-1)
#   - BACKUP_KEEP  (Default: 5; Anzahl der vorzuhaltenden Backups pro Format)
#
# Erzeugt zwei Dateien im BACKUP_DIR:
#   dev-<TIMESTAMP><label>.dump   (custom format, restore-fähig via pg_restore)
#   dev-<TIMESTAMP><label>.sql.gz (plain SQL, gz-komprimiert, grep-bar)
#
# Beispiele:
#   bash scripts/backup-dev-db.sh
#   BACKUP_LABEL="-pre-phase-1" bash scripts/backup-dev-db.sh
#   npm run db:backup-dev

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Voraussetzungen ------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FEHLER: DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "FEHLER: pg_dump nicht im PATH. Bitte PostgreSQL Client 16+ installieren." >&2
  exit 1
fi

# --- Sicherheits-Guards: niemals gegen Produktion -------------------------
# Geteilte Guard-Logik (Task #1437) — setzt bei Erfolg DEV_HOST.
# shellcheck source=scripts/lib/assert-dev-db.sh
source "$SCRIPT_DIR/lib/assert-dev-db.sh"
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "Für Prod-Backups: scripts/backup-prod-db.sh (docs/pre-publish-backup-runbook.md)." >&2
fi
assert_dev_db "backup-dev-db.sh"

BACKUP_DIR="${BACKUP_DIR:-tmp/db-backups/dev}"
BACKUP_LABEL="${BACKUP_LABEL:-}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"

mkdir -p "$BACKUP_DIR"

DUMP_FILE="$BACKUP_DIR/dev-${TIMESTAMP}${BACKUP_LABEL}.dump"
SQL_FILE="$BACKUP_DIR/dev-${TIMESTAMP}${BACKUP_LABEL}.sql.gz"

echo "==> Dev-DB-Backup"
echo "    Host:        $DEV_HOST"
echo "    Ziel:        $BACKUP_DIR"
echo "    Zeitstempel: $TIMESTAMP (UTC)"
echo "    Vorhalten:   letzte $BACKUP_KEEP pro Format"
echo

echo "==> Schreibe Custom-Format-Dump ($DUMP_FILE)"
pg_dump --no-owner --no-privileges --format=custom --file="$DUMP_FILE" "$DATABASE_URL"

echo "==> Schreibe Plain-SQL-Dump ($SQL_FILE)"
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$SQL_FILE"

# --- Retention: nur die letzten N pro Format behalten ---------------------
prune() {
  local pattern="$1" old
  old="$( (ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null || true) | tail -n +"$((BACKUP_KEEP + 1))" )"
  if [[ -n "$old" ]]; then
    printf '%s\n' "$old" | while read -r f; do
      echo "    Entferne altes Backup: $f"
      rm -f -- "$f"
    done
  fi
}
echo
echo "==> Retention (letzte $BACKUP_KEEP pro Format)"
prune "dev-*.dump"
prune "dev-*.sql.gz"

DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
SQL_SIZE="$(du -h "$SQL_FILE" | cut -f1)"

echo
echo "==> Fertig."
echo "    Custom-Dump: $DUMP_FILE ($DUMP_SIZE)"
echo "    Plain-Dump:  $SQL_FILE ($SQL_SIZE)"
echo "    SHA256 (custom): $(sha256sum "$DUMP_FILE" | awk '{print $1}')"
echo "    SHA256 (plain):  $(sha256sum "$SQL_FILE"  | awk '{print $1}')"
echo
echo "    Vorhandene Dev-Backups (.dump):"
ls -1t "$BACKUP_DIR"/dev-*.dump 2>/dev/null | sed 's/^/      /' || true
