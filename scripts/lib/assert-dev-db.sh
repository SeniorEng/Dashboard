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
# Datenbankname aus einer Connection-URL (Pfad-Segment, lowercased).
# Spiegelbild zu `dbNameOf` in shared/ephemeral-db-target.ts.
db_name_of() {
  local url="${1:-}" n
  # `sed -n … p`: gibt NUR bei Treffer aus. Die erste Fassung benutzte
  # `sed 's#...##'` — trifft das Muster nicht, gibt sed die EINGABE unveraendert
  # zurueck. Der Rueckgabewert war dann die ganze URL, also nicht-leer, also
  # griff der `[[ -z ... ]]`-Zweig der Aufrufer nicht: fail-OPEN, wo der
  # TS-Zwilling `dbNameOf` fail-closed ist. Bei `reseed-dev-db.sh` haengt daran
  # ein `DROP SCHEMA public CASCADE`.
  #
  # Schema-Zeichensatz identisch zu `db_host_of` (inkl. Grossschreibung), und
  # Query/Fragment werden abgeschnitten wie in `new URL().pathname`.
  n="$(printf '%s' "$url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/?#]*@)?[^/?#]+/([^?#]+).*$#\2#p')"
  printf '%s' "${n,,}"
}

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
#   4. DATABASE_URL == PROD_DATABASE_URL (Host UND Datenbank).
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
    # Host UND Datenbankname. Nur-Host liess den Fall "gleicher Host, andere
    # Datenbank" durch — und genau das war der Vorfall.
    local prod_db dev_db
    prod_db="$(db_name_of "$PROD_DATABASE_URL")"
    dev_db="$(db_name_of "$DATABASE_URL")"
    if [[ -n "$prod_host" && "$DEV_HOST" == "$prod_host" ]] \
       && { [[ -z "$prod_db" || -z "$dev_db" ]] || [[ "$prod_db" == "$dev_db" ]]; }; then
      echo "ABBRUCH: DATABASE_URL == PROD_DATABASE_URL ('$DEV_HOST'). Verweigert." >&2
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
# Produktion aus"). Gemessen bestehen `helium` (die Replit-Wegwerf-Default-DB, NICHT Prod), die
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

  # Prod-Reject — Spiegelbild zu `assertDevWriteTargetOrThrow`. Ohne ihn haette
  # die Bash-Seite Baustein 1, aber nicht Baustein 2, und der Paritaets-Anspruch
  # waere nur halb eingeloest. An dieser Funktion haengen die destruktiven
  # psql-Skripte, die den TS-Chokepoint nie sehen.
  if [[ -n "${PROD_DATABASE_URL:-}" ]]; then
    local prod_host prod_db
    prod_host="$(db_host_of "$PROD_DATABASE_URL")"
    prod_db="$(db_name_of "$PROD_DATABASE_URL")"
    if [[ -z "$prod_host" || -z "$prod_db" ]]; then
      echo "ABBRUCH: PROD_DATABASE_URL ist gesetzt, aber nicht auswertbar. Fail-closed." >&2
      exit 1
    fi
    if [[ "$prod_host" == "$host" && "$prod_db" == "$db_name" ]]; then
      echo "ABBRUCH: \"${tatsaechlich}\" IST die Produktionsdatenbank (PROD_DATABASE_URL)." >&2
      echo "  Ein schreibender Dev-Lauf geht dorthin nie — auch nicht mit passendem" >&2
      echo "  DEV_WRITE_CONFIRM_TARGET." >&2
      exit 1
    fi
    echo "Prod-Reject aktiv, verglichen gegen ${prod_host}/${prod_db}"
  else
    echo "Hinweis: PROD_DATABASE_URL nicht gesetzt — kein Prod-Reject moeglich."
  fi

  echo "Dev-Ziel bestaetigt: ${tatsaechlich}"
}
