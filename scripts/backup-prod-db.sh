#!/usr/bin/env bash
#
# backup-prod-db.sh — Pre-publish full backup of the Production-Postgres-DB.
#
# Wann ausführen?
#   Direkt vor jedem Publish, das Schema-Änderungen (insbesondere DROP COLUMN /
#   DROP TABLE) auf die Production-DB anwendet. Siehe
#   docs/pre-publish-backup-runbook.md.
#
# Voraussetzungen:
#   - pg_dump (PostgreSQL Client 16+) im PATH
#   - Umgebungsvariable PROD_DATABASE_URL gesetzt
#       Beispiel: postgres://user:pw@host:5432/dbname
#       (Die URL findest du im Replit Publishing-Tab unter "Environment".)
#
# Optional:
#   - BACKUP_DIR (Default: tmp/db-backups)
#   - BACKUP_LABEL (Default: leer; wird Teil des Dateinamens)
#
# Erzeugt zwei Dateien im BACKUP_DIR:
#   prod-<TIMESTAMP><label>.dump   (custom format, restore-fähig via pg_restore)
#   prod-<TIMESTAMP><label>.sql.gz (plain SQL, gz-komprimiert, grep-bar)
#
# Beispiel:
#   PROD_DATABASE_URL="postgres://..." bash scripts/backup-prod-db.sh
#   PROD_DATABASE_URL="postgres://..." BACKUP_LABEL="-pre-sprint-228" bash scripts/backup-prod-db.sh

set -euo pipefail

if [[ -z "${PROD_DATABASE_URL:-}" ]]; then
  echo "FEHLER: PROD_DATABASE_URL ist nicht gesetzt." >&2
  echo "Setze sie mit dem Connection-String aus dem Replit Publishing-Tab und versuche es erneut." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "FEHLER: pg_dump nicht im PATH. Bitte PostgreSQL Client 16+ installieren." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-tmp/db-backups}"
BACKUP_LABEL="${BACKUP_LABEL:-}"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"

mkdir -p "$BACKUP_DIR"

DUMP_FILE="$BACKUP_DIR/prod-${TIMESTAMP}${BACKUP_LABEL}.dump"
SQL_FILE="$BACKUP_DIR/prod-${TIMESTAMP}${BACKUP_LABEL}.sql.gz"

echo "==> Backup-Ziel: $BACKUP_DIR"
echo "==> Zeitstempel (UTC): $TIMESTAMP"
echo

echo "==> Schreibe Custom-Format-Dump ($DUMP_FILE)"
pg_dump \
  --no-owner \
  --no-privileges \
  --format=custom \
  --file="$DUMP_FILE" \
  "$PROD_DATABASE_URL"

echo "==> Schreibe Plain-SQL-Dump ($SQL_FILE)"
pg_dump \
  --no-owner \
  --no-privileges \
  --format=plain \
  "$PROD_DATABASE_URL" \
  | gzip -9 > "$SQL_FILE"

DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
SQL_SIZE="$(du -h "$SQL_FILE" | cut -f1)"

echo
echo "==> Fertig."
echo "    Custom-Dump:  $DUMP_FILE  ($DUMP_SIZE)"
echo "    Plain-Dump:   $SQL_FILE   ($SQL_SIZE)"
echo
echo "Nächste Schritte:"
echo "  1. Dateien an einen sicheren Ort außerhalb der Repl kopieren (z.B. lokal herunterladen)."
echo "  2. Eintrag in docs/deployment-log.md ergänzen (Zeitstempel, Pfad, SHA256)."
echo "     SHA256 (custom): $(sha256sum "$DUMP_FILE" | awk '{print $1}')"
echo "     SHA256 (plain):  $(sha256sum "$SQL_FILE"  | awk '{print $1}')"
