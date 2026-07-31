#!/usr/bin/env bash
#
# reseed-dev-db.sh — Setzt die langlebige DEV-DB (DATABASE_URL) auf eine saubere,
# reproduzierbare SYNTHETISCHE Basis zurück (Task #1239).
#
# ERSETZT (Ersetzungs-Regel):
#   - den veralteten großen Import-Datensatz in der Dev-DB
#   - das tote Ad-hoc-Seed-Skript script/seed.ts (wird im selben Task gelöscht;
#     referenzierte eine nicht mehr existierende customers.avatar-Spalte).
#
# Strategie: SYNTHETISCH/geseedet (kein Prod-Import). Pflegedaten sind echte
# PII — ein Prod->Dev-Kopieren (auch "anonymisiert") trägt DSGVO-/GoBD-Risiko.
# Siehe docs/dev-database-runbook.md.
#
# Was es tut (nur mit --apply):
#   1. Backup der aktuellen Dev-DB (scripts/backup-dev-db.sh), außer --no-backup.
#   2. DROP SCHEMA public CASCADE; CREATE SCHEMA public; (+ drizzle-Migrations-Schema).
#   3. drizzle-kit push --force (Schema neu anlegen).
#   4. tsx scripts/ci-seed-superadmin.ts (Superadmin-Login-Konto).
#   5. tsx scripts/seed-test-reference-data.ts (Basis-Leistungen + Firmenidentität).
#
# Saubere Basis danach: 1 Superadmin (Login s.u.), 2 Basis-Leistungen
# (Hauswirtschaft, Alltagsbegleitung) mit je 3 Budget-Töpfen, company_settings
# Test-Firmenidentität. KEINE synthetischen Kunden/Termine — diese werden bei
# Bedarf über die UI angelegt.
#
# PFLICHT-NACHSCHRITT: Den "Start application"-Workflow neu starten. Erst der
# Server-Boot (runStartupTasks() in server/index.ts) legt die GoBD-/Audit-Trigger
# und die idempotenten Spalten-/Daten-Migrationen an und macht die Basis
# vollständig (/api/health -> startupComplete: true).
#
# Login nach dem Reseed: TEST_USER_EMAIL / TEST_USER_PASSWORD
# (Fallback TEST_USER_PASSWORD_INTERNAL). Die SUPER_ADMIN_EMAIL-Promotion beim
# Boot flaggt nur eine bestehende Zeile, legt KEINEN User an.
#
# NICHT für Produktion. Default ist Trockenlauf.
#
# CLI:
#   bash scripts/reseed-dev-db.sh                      # Trockenlauf (Plan + Zeilen)
#   bash scripts/reseed-dev-db.sh --apply              # scharf (fragt Bestätigung)
#   bash scripts/reseed-dev-db.sh --apply --yes        # scharf, ohne Rückfrage
#   bash scripts/reseed-dev-db.sh --apply --no-backup  # ohne Pre-Reseed-Backup
#   npm run db:reseed-dev -- --apply

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APPLY=0
ASSUME_YES=0
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    *) echo "Unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

# --- Voraussetzungen ------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FEHLER: DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi
for bin in psql pg_dump npx; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FEHLER: $bin nicht im PATH." >&2; exit 1; }
done

# --- Guards: niemals gegen Produktion ------------------------------------
# Geteilte Guard-Logik (Task #1437) — setzt bei Erfolg DEV_HOST.
# shellcheck source=scripts/lib/assert-dev-db.sh
source "$SCRIPT_DIR/lib/assert-dev-db.sh"
assert_dev_db "reseed-dev-db.sh"

# --- Preflight: Login-Credentials MÜSSEN vorhanden sein ------------------
# ci-seed-superadmin.ts ist ein No-Op (exit 0), wenn die Credentials fehlen.
# Ohne diesen Check bliebe die Dev-DB nach dem Reseed OHNE Login-Konto zurück,
# während das Skript "Erfolg" meldet. Daher hart abbrechen, BEVOR irgendetwas
# gelöscht wird.
if [[ -z "${TEST_USER_EMAIL:-}" || ( -z "${TEST_USER_PASSWORD:-}" && -z "${TEST_USER_PASSWORD_INTERNAL:-}" ) ]]; then
  echo "ABBRUCH: TEST_USER_EMAIL und TEST_USER_PASSWORD (oder TEST_USER_PASSWORD_INTERNAL)" >&2
  echo "        müssen gesetzt sein — sonst bliebe die Dev-DB ohne Login-Konto zurück." >&2
  exit 1
fi

# --- Aktuellen Stand anzeigen --------------------------------------------
echo "============================================================"
echo " DEV-DB RESEED  (Host: $DEV_HOST)"
echo "============================================================"
echo "Aktueller Stand der Dev-DB:"
psql "$DATABASE_URL" -tAc "SELECT '  Kunden:  '||count(*) FROM customers"      2>/dev/null || echo "  (customers: n/a)"
psql "$DATABASE_URL" -tAc "SELECT '  Termine: '||count(*) FROM appointments"   2>/dev/null || echo "  (appointments: n/a)"
psql "$DATABASE_URL" -tAc "SELECT '  User:    '||count(*) FROM users"          2>/dev/null || echo "  (users: n/a)"
# Andere aktive Verbindungen (z.B. laufender Dev-Server) zählen — nur Hinweis.
OTHER_CONNS="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()" 2>/dev/null || echo "?")"
echo
echo "Geplante Schritte (mit --apply):"
[[ "$DO_BACKUP" == "1" ]] && echo "  1. Backup (scripts/backup-dev-db.sh, Label -pre-reseed)"
echo "  2. DROP SCHEMA public CASCADE + CREATE SCHEMA public (+ drizzle-Schema)"
echo "  3. drizzle-kit push --force"
echo "  4. Superadmin-Seed (ci-seed-superadmin.ts)"
echo "  5. Referenzdaten-Seed (seed-test-reference-data.ts)"
echo "  Danach manuell: 'Start application'-Workflow neu starten (Startup-Migrationen)."
echo
if [[ "$OTHER_CONNS" != "0" && "$OTHER_CONNS" != "?" ]]; then
  echo "HINWEIS: $OTHER_CONNS weitere aktive DB-Verbindung(en) erkannt (vermutlich der"
  echo "         laufende 'Start application'-Workflow). Empfehlung: den Workflow VOR dem"
  echo "         Reseed stoppen, damit er nicht mitten im Wipe auf gedroppte Tabellen"
  echo "         zugreift und neu startet. (Idle-Pool-Verbindungen blockieren das DROP nicht.)"
  echo
fi

if [[ "$APPLY" != "1" ]]; then
  echo "TROCKENLAUF — nichts wurde verändert. Mit --apply scharf ausführen."
  exit 0
fi

if [[ "$ASSUME_YES" != "1" ]]; then
  echo "Dies LÖSCHT ALLE Daten in der Dev-DB ($DEV_HOST) unwiderruflich."
  read -r -p "Zum Fortfahren 'RESEED' eingeben: " CONFIRM
  if [[ "$CONFIRM" != "RESEED" ]]; then
    echo "Abgebrochen."
    exit 1
  fi
fi

# --- 1. Backup ------------------------------------------------------------
if [[ "$DO_BACKUP" == "1" ]]; then
  echo
  echo "==> [1/5] Backup der aktuellen Dev-DB ..."
  BACKUP_LABEL="-pre-reseed" bash "$SCRIPT_DIR/backup-dev-db.sh"
fi

# --- 2. Schema wipe -------------------------------------------------------
echo
echo "==> [2/5] Schema zurücksetzen (DROP/CREATE) ..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

# --- 3. Schema push -------------------------------------------------------
# Schema-Push und beide Seeds sind seit dem Wegwerf-DB-Guard fail-closed
# (scripts/lib/ephemeral-db-guard.ts) und laufen sonst nur auf `cc_test_`-DBs.
# Dieses Skript zielt bewusst auf die DEV-DB und erklärt seine Absicht deshalb
# ausdrücklich — abgesichert durch den eigenen `--apply`- + Hostname-Guard oben.
export ALLOW_NON_EPHEMERAL_DB_WRITE=1

echo
echo "==> [3/5] drizzle-kit push --force ..."
npx drizzle-kit push --force

# --- 4. Superadmin --------------------------------------------------------
echo
echo "==> [4/5] Superadmin-Seed ..."
npx tsx "$SCRIPT_DIR/ci-seed-superadmin.ts"

# --- 5. Referenzdaten -----------------------------------------------------
echo
echo "==> [5/5] Referenzdaten-Seed ..."
npx tsx "$SCRIPT_DIR/seed-test-reference-data.ts"

echo
echo "============================================================"
echo " RESEED FERTIG."
echo "============================================================"
echo "Stand der sauberen Basis:"
psql "$DATABASE_URL" -tAc "SELECT '  Kunden:  '||count(*) FROM customers"    2>/dev/null || true
psql "$DATABASE_URL" -tAc "SELECT '  User:    '||count(*) FROM users"        2>/dev/null || true
psql "$DATABASE_URL" -tAc "SELECT '  Services:'||count(*) FROM services"     2>/dev/null || true
echo
echo "Nächster Schritt (PFLICHT):"
echo "  'Start application'-Workflow neu starten — runStartupTasks() legt die"
echo "  GoBD-/Audit-Trigger + idempotenten Migrationen an und macht die Basis"
echo "  vollständig (/api/health -> startupComplete: true)."
echo
echo "Login: TEST_USER_EMAIL / TEST_USER_PASSWORD (bzw. TEST_USER_PASSWORD_INTERNAL)."
