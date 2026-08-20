#!/usr/bin/env bash
#
# assert-dev-db.sh — Geteilte Prod-Schutz-Guards für die Dev-DB-Shell-Skripte.
#
# Zweck (Task #1437, Ersetzungs-Regel):
#   ERSETZT die bis dahin ZEICHENGLEICH in scripts/backup-dev-db.sh UND
#   scripts/reseed-dev-db.sh kopierten Guard-Blöcke durch EINE sourceable
#   Quelle. Eine Korrektur der Prod-Schutz-Logik muss damit nur noch hier
#   gepflegt werden (statt an mehreren Stellen synchron).
#
# Sinngleiche Logik existiert (in TypeScript) auch in
# server/lib/dev-db-guard.ts (re-exportiert von
# server/scripts/sweep-dev-test-data.ts); diese Datei deckt die beiden
# Shell-Skripte ab. Da ein TS-Modul keine Shell-Funktion sourcen kann (und
# umgekehrt), wird das Auseinanderdriften beider Welten durch den
# Cross-Language-Paritäts-Test tests/architecture/dev-db-guard-parity.test.ts
# abgesichert: er reicht EINE Fixtures-Tabelle durch BEIDE Implementierungen.
# Wer hier die Host-/Prod-Erkennung ändert, muss sie auch in dev-db-guard.ts
# nachziehen, sonst bricht der Paritäts-Test.
#
# Verwendung (in einem Skript mit `set -euo pipefail`):
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=scripts/lib/assert-dev-db.sh
#   source "$SCRIPT_DIR/lib/assert-dev-db.sh"
#   assert_dev_db "name-des-skripts.sh"
#
# Nach erfolgreichem assert_dev_db ist die globale Variable DEV_HOST gesetzt
# (der gegen die Guards geprüfte Host aus DATABASE_URL).

# Hostname (nicht Substring) aus einem Connection-String extrahieren — gespiegelt
# aus server/scripts/cleanup-test-data.ts. Credentials (user:pass@) sind optional,
# damit auch Connection-Strings OHNE Anmeldedaten korrekt geparst werden (sonst
# Host leer → Guards greifen nicht).
db_host_of() {
  local url="$1" h
  h="$(printf '%s' "$url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/?#]*@)?([^:/?#]+).*$#\2#p')"
  printf '%s' "${h,,}"
}

# assert_dev_db [<skript-name>]
#
# Bricht das aufrufende Skript ab, falls es nach Produktion aussieht. Prüft in
# Reihenfolge:
#   1. NODE_ENV=production.
#   2. Host aus DATABASE_URL nicht extrahierbar → fail-closed.
#   3. Prod-aussehender DB-Host.
#   4. DATABASE_URL-Host == PROD_DATABASE_URL-Host.
#
# Setzt bei Erfolg die globale Variable DEV_HOST.
assert_dev_db() {
  local script_name="${1:-dev-db-skript}"

  # --- Guard 1: niemals gegen Produktion --------------------------------
  if [[ "${NODE_ENV:-}" == "production" ]]; then
    echo "ABBRUCH: NODE_ENV=production. ${script_name} ist nur für die Dev-DB." >&2
    exit 1
  fi

  # --- Guard 2: Host bestimmen, fail-closed -----------------------------
  DEV_HOST="$(db_host_of "${DATABASE_URL:-}")"
  if [[ -z "$DEV_HOST" ]]; then
    echo "ABBRUCH: DB-Host konnte aus DATABASE_URL nicht extrahiert werden. Verweigert (fail-closed)." >&2
    exit 1
  fi

  # --- Guard 3: Prod-aussehender Host -----------------------------------
  if printf '%s' "$DEV_HOST" | grep -Eq '(^|[.-])prod([.-]|$)|production'; then
    echo "ABBRUCH: DB-Host '$DEV_HOST' sieht nach Produktion aus. Verweigert." >&2
    exit 1
  fi

  # --- Guard 4: niemals denselben Host wie Prod -------------------------
  if [[ -n "${PROD_DATABASE_URL:-}" ]]; then
    local prod_host
    prod_host="$(db_host_of "$PROD_DATABASE_URL")"
    if [[ -n "$prod_host" && "$DEV_HOST" == "$prod_host" ]]; then
      echo "ABBRUCH: DATABASE_URL-Host == PROD_DATABASE_URL-Host ('$DEV_HOST'). Verweigert." >&2
      exit 1
    fi
  fi
}

# ---------------------------------------------------------------------------
# assert_dev_write_target — POSITIVE Ziel-Pruefung fuer schreibende Dev-Laeufe.
#
# Spiegelbild zu `assertDevWriteTargetOrThrow` in server/lib/dev-db-guard.ts;
# die Paritaet haelt `tests/architecture/dev-db-guard-parity.test.ts` fest.
#
# `assert_dev_db` oben ist ein NEGATIVES Praedikat ("Host sieht nicht nach
# Produktion aus"). Gemessen bestehen `helium` (der echte Prod-Host), die
# Neon-Prod-Form `ep-....aws.neon.tech` und `localhost` diesen Test glatt —
# "nicht Prod" ist auch fuer eine unbekannte DB wahr. Deshalb hier die
# Umkehrung: das Ziel muss BENANNT werden, und der Datenbankname kommt aus der
# OFFENEN Verbindung, nicht aus der URL.
#
# Aufruf:  assert_dev_write_target "<skriptname>"
# Erwartet: DEV_WRITE_CONFIRM_TARGET="<host>/<datenbank>"
assert_dev_write_target() {
  local script_name="${1:-unbekannt}"

  # Erst der billige Screen (identisch zur TS-Seite).
  assert_dev_db "$script_name"

  if [[ -z "${DEV_WRITE_CONFIRM_TARGET:-}" ]]; then
    echo "ABBRUCH: ${script_name} erfordert DEV_WRITE_CONFIRM_TARGET=\"<host>/<datenbank>\"." >&2
    echo "  Der Datenbankname wird an der OFFENEN Verbindung geprueft, nicht aus der URL" >&2
    echo "  gelesen — 'nicht nach Prod aussehend' ist KEIN Nachweis." >&2
    exit 1
  fi

  local host db_name tatsaechlich
  host="$(db_host_of "$DATABASE_URL")"
  db_name="$(psql "$DATABASE_URL" -tAc 'SELECT current_database()' 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$db_name" ]]; then
    echo "ABBRUCH: current_database() konnte nicht ermittelt werden (fail-closed)." >&2
    exit 1
  fi
  tatsaechlich="${host}/${db_name}"

  if [[ "$DEV_WRITE_CONFIRM_TARGET" != "$tatsaechlich" ]]; then
    echo "ABBRUCH: DEV_WRITE_CONFIRM_TARGET=\"${DEV_WRITE_CONFIRM_TARGET}\", die offene" >&2
    echo "  Verbindung zeigt aber auf \"${tatsaechlich}\". Verweigert." >&2
    exit 1
  fi

  echo "Dev-Ziel bestaetigt: ${tatsaechlich}"
}
