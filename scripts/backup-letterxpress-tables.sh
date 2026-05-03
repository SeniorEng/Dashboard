#!/usr/bin/env bash
#
# backup-letterxpress-tables.sh — Fokussierter Pre-Publish-Backup der
# Tabellen, die durch Migration 0017 (Switch Deutsche Post E-POST →
# LetterXpress, Task #302/#303) verändert werden.
#
# Betroffene Daten (Stand vor Migration 0017):
#   - company_settings.epost_vendor_id   (DROP COLUMN)
#   - company_settings.epost_ekp         (DROP COLUMN)
#   - company_settings.epost_password    (DROP COLUMN)
#   - company_settings.epost_secret      (DROP COLUMN)
#   - company_settings.epost_test_mode   (DROP COLUMN)
#   - document_deliveries.epost_letter_id → letterxpress_letter_id (RENAME)
#
# Erzeugt einen kleinen, gut prüfbaren Snapshot ausschließlich der betroffenen
# Daten — als zusätzliche Sicherheit neben dem vollen pg_dump
# (siehe scripts/backup-prod-db.sh).
#
# Voraussetzungen wie scripts/backup-prod-db.sh:
#   - pg_dump und psql im PATH
#   - PROD_DATABASE_URL gesetzt (aus Replit Publishing-Tab)
#
# Beispiel:
#   PROD_DATABASE_URL="postgres://..." bash scripts/backup-letterxpress-tables.sh

set -euo pipefail

if [[ -z "${PROD_DATABASE_URL:-}" ]]; then
  echo "FEHLER: PROD_DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "FEHLER: pg_dump nicht im PATH." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "FEHLER: psql nicht im PATH (wird für CSV-Exports gebraucht)." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-tmp/db-backups}"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
TARGET_DIR="$BACKUP_DIR/letterxpress-${TIMESTAMP}"

mkdir -p "$TARGET_DIR"

echo "==> Fokus-Backup nach $TARGET_DIR"

echo "==> 1/3  Tabellen-Dump (company_settings, document_deliveries — Schema + Daten)"
pg_dump \
  --no-owner \
  --no-privileges \
  --format=plain \
  --table=public.company_settings \
  --table=public.document_deliveries \
  "$PROD_DATABASE_URL" \
  | gzip -9 > "$TARGET_DIR/letterxpress-tables.sql.gz"

echo "==> 2/3  CSV-Snapshot der direkt betroffenen Spalten (gut diff-bar)"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "\copy (SELECT id, epost_vendor_id, epost_ekp, epost_password, epost_secret, epost_test_mode FROM public.company_settings ORDER BY id) TO '$TARGET_DIR/company_settings_epost_columns.csv' WITH CSV HEADER"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "\copy (SELECT id, epost_letter_id, status, sent_at FROM public.document_deliveries WHERE epost_letter_id IS NOT NULL ORDER BY id) TO '$TARGET_DIR/document_deliveries_epost_letter_id.csv' WITH CSV HEADER"

echo "==> 3/3  Row-Count-Bericht"

{
  echo "Snapshot UTC: $TIMESTAMP"
  echo
  echo "company_settings — Zeilen gesamt:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.company_settings;"
  echo
  echo "company_settings — Zeilen mit nicht-leerem epost_vendor_id:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.company_settings WHERE epost_vendor_id IS NOT NULL AND epost_vendor_id <> '';"
  echo
  echo "company_settings — Zeilen mit nicht-leerem epost_ekp:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.company_settings WHERE epost_ekp IS NOT NULL AND epost_ekp <> '';"
  echo
  echo "company_settings — Zeilen mit nicht-leerem epost_password:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.company_settings WHERE epost_password IS NOT NULL AND epost_password <> '';"
  echo
  echo "company_settings — Zeilen mit nicht-leerem epost_secret:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.company_settings WHERE epost_secret IS NOT NULL AND epost_secret <> '';"
  echo
  echo "document_deliveries — Zeilen gesamt:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.document_deliveries;"
  echo
  echo "document_deliveries — Zeilen mit epost_letter_id IS NOT NULL (werden umbenannt zu letterxpress_letter_id):"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.document_deliveries WHERE epost_letter_id IS NOT NULL;"
} > "$TARGET_DIR/row-count-report.txt"

cat "$TARGET_DIR/row-count-report.txt"

echo
echo "==> Fertig. Verzeichnis: $TARGET_DIR"
echo "    Inhalt:"
ls -lh "$TARGET_DIR"
echo
echo "SHA256-Summen:"
( cd "$TARGET_DIR" && sha256sum * )
