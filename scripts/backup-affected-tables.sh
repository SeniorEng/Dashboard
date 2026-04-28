#!/usr/bin/env bash
#
# backup-affected-tables.sh — Fokussierter Dump der Tabellen, die durch
# Sprint #228 (Schema-Audit) ihre Spalten/Tabelle verlieren.
#
# Erzeugt einen kleinen, gut prüfbaren Snapshot ausschließlich der betroffenen
# Daten — als zusätzliche Sicherheit neben dem vollen pg_dump
# (siehe scripts/backup-prod-db.sh).
#
# Betroffene Daten (Stand 2026-04-28, siehe docs/schema-audit-report.md):
#   - appointments.services_done                   (~735 Zeilen, 0 befüllt)
#   - customer_contracts.hauswirtschaft_rate_cents (~108 Zeilen, alle 0)
#   - customer_contracts.alltagsbegleitung_rate_cents (~108 Zeilen, alle 0)
#   - customer_contracts.kilometer_rate_cents      (~108 Zeilen, alle 0)
#   - Tabelle customer_pricing_history             (Prod: leer)
#
# Voraussetzungen wie scripts/backup-prod-db.sh:
#   - pg_dump im PATH
#   - PROD_DATABASE_URL gesetzt
#
# Beispiel:
#   PROD_DATABASE_URL="postgres://..." bash scripts/backup-affected-tables.sh

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
TARGET_DIR="$BACKUP_DIR/affected-${TIMESTAMP}"

mkdir -p "$TARGET_DIR"

echo "==> Fokus-Backup nach $TARGET_DIR"

echo "==> 1/3  Tabellen-Dump (appointments, customer_contracts, customer_pricing_history)"
pg_dump \
  --no-owner \
  --no-privileges \
  --format=plain \
  --table=public.appointments \
  --table=public.customer_contracts \
  --table=public.customer_pricing_history \
  "$PROD_DATABASE_URL" \
  | gzip -9 > "$TARGET_DIR/affected-tables.sql.gz"

echo "==> 2/3  CSV-Snapshot der betroffenen Spalten (gut diff-bar)"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "\copy (SELECT id, services_done FROM public.appointments WHERE services_done IS NOT NULL AND array_length(services_done, 1) > 0 ORDER BY id) TO '$TARGET_DIR/appointments_services_done.csv' WITH CSV HEADER"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "\copy (SELECT id, customer_id, hauswirtschaft_rate_cents, alltagsbegleitung_rate_cents, kilometer_rate_cents, contract_start, contract_end FROM public.customer_contracts ORDER BY id) TO '$TARGET_DIR/customer_contracts_legacy_rates.csv' WITH CSV HEADER"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "\copy (SELECT * FROM public.customer_pricing_history ORDER BY id) TO '$TARGET_DIR/customer_pricing_history.csv' WITH CSV HEADER"

echo "==> 3/3  Row-Count-Bericht"

{
  echo "Snapshot UTC: $TIMESTAMP"
  echo
  echo "appointments.services_done — Zeilen mit Inhalt (array_length > 0):"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.appointments WHERE services_done IS NOT NULL AND array_length(services_done, 1) > 0;"
  echo
  echo "customer_contracts — Zeilen gesamt:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.customer_contracts;"
  echo
  echo "customer_contracts — Zeilen mit hauswirtschaft_rate_cents <> 0:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.customer_contracts WHERE hauswirtschaft_rate_cents IS NOT NULL AND hauswirtschaft_rate_cents <> 0;"
  echo
  echo "customer_contracts — Zeilen mit alltagsbegleitung_rate_cents <> 0:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.customer_contracts WHERE alltagsbegleitung_rate_cents IS NOT NULL AND alltagsbegleitung_rate_cents <> 0;"
  echo
  echo "customer_contracts — Zeilen mit kilometer_rate_cents <> 0:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.customer_contracts WHERE kilometer_rate_cents IS NOT NULL AND kilometer_rate_cents <> 0;"
  echo
  echo "customer_pricing_history — Zeilen gesamt:"
  psql "$PROD_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM public.customer_pricing_history;"
} > "$TARGET_DIR/row-count-report.txt"

cat "$TARGET_DIR/row-count-report.txt"

echo
echo "==> Fertig. Verzeichnis: $TARGET_DIR"
echo "    Inhalt:"
ls -lh "$TARGET_DIR"
echo
echo "SHA256-Summen:"
( cd "$TARGET_DIR" && sha256sum * )
