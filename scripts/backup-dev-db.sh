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
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "ABBRUCH: NODE_ENV=production. backup-dev-db.sh ist nur für die Dev-DB." >&2
  echo "Für Prod-Backups: scripts/backup-prod-db.sh (docs/pre-publish-backup-runbook.md)." >&2
  exit 1
fi

# Hostname (nicht Substring) aus dem Connection-String extrahieren und gegen
# prod-Pattern prüfen — gespiegelt aus server/scripts/cleanup-test-data.ts.
# Credentials (user:pass@) sind optional, damit auch Connection-Strings OHNE
# Anmeldedaten korrekt geparst werden (sonst Host leer → Guards greifen nicht).
db_host_of() {
  local url="$1" h
  h="$(printf '%s' "$url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/?#]*@)?([^:/?#]+).*$#\2#p')"
  printf '%s' "${h,,}"
}
DEV_HOST="$(db_host_of "$DATABASE_URL")"
# Fail-closed: Lässt sich der Host nicht bestimmen, können die Prod-Guards nicht
# greifen → lieber abbrechen als blind eine unbekannte DB sichern.
if [[ -z "$DEV_HOST" ]]; then
  echo "ABBRUCH: DB-Host konnte aus DATABASE_URL nicht extrahiert werden. Verweigert (fail-closed)." >&2
  exit 1
fi
if printf '%s' "$DEV_HOST" | grep -Eq '(^|[.-])prod([.-]|$)|production'; then
  echo "ABBRUCH: DB-Host '$DEV_HOST' sieht nach Produktion aus. Verweigert." >&2
  exit 1
fi
# Falls PROD_DATABASE_URL ebenfalls gesetzt ist: niemals denselben Host wie Prod sichern.
if [[ -n "${PROD_DATABASE_URL:-}" ]]; then
  PROD_HOST="$(db_host_of "$PROD_DATABASE_URL")"
  if [[ -n "$PROD_HOST" && "$DEV_HOST" == "$PROD_HOST" ]]; then
    echo "ABBRUCH: DATABASE_URL-Host == PROD_DATABASE_URL-Host ('$DEV_HOST'). Verweigert." >&2
    exit 1
  fi
fi

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
