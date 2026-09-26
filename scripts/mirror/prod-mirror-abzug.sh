#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prod-Mirror-Abzug (Ticket 6hf36pRXqr2FR8JG) — von Alrik von Hand gestartet.
#
#   Prod (Neon, nur lesen, Rolle mirror_reader) → pg_dump im Snapshot
#   → Staging-DB im Mirror-Cluster → pseudonymisieren → prüfen (Abnahme 1–3)
#   → prod_mirror ersetzen → Stichtag in mirror_meta.
#
# Aufruf (auf engeldesk-01, im Repo):   bash scripts/mirror/prod-mirror-abzug.sh
#
# Das Skript FRAGT (nichts davon steht in Datei, History, Kommandozeile oder
# einer exportierten Variable der aufrufenden Shell):
#   1. Neon-Host (direkter Endpunkt, OHNE „-pooler") — sichtbar, kein Geheimnis
#   2. Passwort von mirror_reader — verdeckt
#   3. Passwort des Mirror-Admins (postgres im Mirror-Container) — verdeckt
# Die Geheimnisse leben nur im Speicher dieses Prozesses und als Umgebung der
# gestarteten psql/pg_dump-Prozesse, solange diese laufen.
#
# Prod wird nur gelesen: Rolle mirror_reader (nur SELECT, default read-only),
# zusätzlich PGOPTIONS default_transaction_read_only=on, pg_dump liest im
# exportierten Snapshot (REPEATABLE READ, READ ONLY).
#
# Rohdaten liegen nur in der Staging-DB (kein Dump auf der Platte). Bricht
# irgendein Schritt ab, wird die Staging-DB gelöscht; prod_mirror bleibt dann
# unverändert (letzter gültiger Abzug).
#
# Für einen lokalen Probelauf gegen eine Test-DB können Host/Port/Datenbank/
# SSL/Benutzer über Umgebungsvariablen gesetzt werden (siehe unten); die
# Eingaben kommen dann per stdin. Im Normalfall sind die Voreinstellungen richtig.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

MIRROR_HOST="${MIRROR_HOST:-127.0.0.1}"
MIRROR_PORT="${MIRROR_PORT:-5433}"
MIRROR_ADMIN="${MIRROR_ADMIN:-postgres}"
MIRROR_DB="${MIRROR_DB:-prod_mirror}"
MIRROR_LESER="${MIRROR_LESER:-cc_readonly}"
STAGING="${MIRROR_DB}_neu"
QUELLE_USER="${QUELLE_USER:-mirror_reader}"
QUELLE_PORT="${QUELLE_PORT:-5432}"
QUELLE_DB_DEFAULT="${QUELLE_DB:-neondb}"
# verify-full + System-CAs (libpq ≥ 16): das Zertifikat wird geprüft (Gate 2 zu #198, S-3).
QUELLE_SSLMODE="${QUELLE_SSLMODE:-verify-full}"
QUELLE_SSLROOTCERT="${QUELLE_SSLROOTCERT-system}"
STICHPROBE_KUNDE="${STICHPROBE_KUNDE:-89}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "ABBRUCH: $*"; exit 1; }

for bin in psql pg_dump python3; do command -v "$bin" >/dev/null || fail "$bin fehlt"; done
[[ "$STAGING" =~ ^[a-z_][a-z0-9_]*$ && "$MIRROR_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "ungültiger DB-Name"

read -r -p "Neon-Host (direkt, ohne -pooler): " QUELLE_HOST
read -r -p "Datenbank [${QUELLE_DB_DEFAULT}]: " QUELLE_DB; QUELLE_DB="${QUELLE_DB:-$QUELLE_DB_DEFAULT}"
read -r -s -p "Passwort ${QUELLE_USER}: " QUELLE_PW; echo >&2
read -r -s -p "Passwort Mirror-Admin (${MIRROR_ADMIN}@${MIRROR_HOST}:${MIRROR_PORT}): " MIRROR_PW; echo >&2
[[ -n "$QUELLE_HOST" && -n "$QUELLE_PW" && -n "$MIRROR_PW" ]] || fail "Eingabe fehlt"
[[ "$QUELLE_HOST" == *-pooler* ]] && fail "Pooler-Host: für den Snapshot den DIREKTEN Endpunkt nehmen (Host ohne „-pooler“)."

# Verbindungen: Werte nur in der Umgebung des jeweiligen Kindprozesses.
quelle() ( export PGHOST="$QUELLE_HOST" PGPORT="$QUELLE_PORT" PGUSER="$QUELLE_USER" PGPASSWORD="$QUELLE_PW" \
           PGDATABASE="$QUELLE_DB" PGSSLMODE="$QUELLE_SSLMODE" PGAPPNAME="prod-mirror-abzug" \
           PGOPTIONS="-c default_transaction_read_only=on"
           if [[ -n "$QUELLE_SSLROOTCERT" ]]; then export PGSSLROOTCERT="$QUELLE_SSLROOTCERT"; fi
           exec "$@" )
mirror() ( export PGHOST="$MIRROR_HOST" PGPORT="$MIRROR_PORT" PGUSER="$MIRROR_ADMIN" PGPASSWORD="$MIRROR_PW" \
           PGAPPNAME="prod-mirror-abzug"; unset PGOPTIONS; exec "$@" )
msql() { local db="$1"; shift; mirror psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"; }

ERFOLG=0
aufraeumen() {
  if [[ -n "${SNAP_PID:-}" ]]; then kill "$SNAP_PID" 2>/dev/null || true; fi
  if [[ "$ERFOLG" != 1 ]]; then
    msql postgres -c "DROP DATABASE IF EXISTS ${STAGING} WITH (FORCE)" >/dev/null 2>&1 || true
    say "Staging-DB ${STAGING} gelöscht. ${MIRROR_DB} ist unverändert."
  fi
}
trap aufraeumen EXIT

# ── 0. Versionen und Leserecht ────────────────────────────────────────────
Q_VER=$(quelle psql -X -At -c "SHOW server_version_num") || fail "Prod nicht erreichbar (Host/Passwort?)"
M_VER=$(msql postgres -At -c "SHOW server_version_num") || fail "Mirror-Cluster nicht erreichbar"
D_VER=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
Q_MAJ=$((Q_VER / 10000)); M_MAJ=$((M_VER / 10000))
say "Prod: PostgreSQL ${Q_MAJ} · pg_dump: ${D_VER} · Mirror: PostgreSQL ${M_MAJ}"
(( D_VER >= Q_MAJ )) || fail "pg_dump ${D_VER} ist älter als der Prod-Server ${Q_MAJ}"
(( M_MAJ >= Q_MAJ )) || fail "Mirror-Server ${M_MAJ} ist älter als Prod ${Q_MAJ}"
# Nicht `default_transaction_read_only` prüfen — das setzt dieses Skript selbst
# (PGOPTIONS) und sagt nichts über die Rolle (Gate 2 zu #198, S-2). Geprüft wird
# die ROLLE: richtiger Name, kein Superuser, kein CREATE auf Datenbank/Schema,
# keine Schreibrechte auf irgendeine Tabelle in public.
ROLLE=$(quelle psql -X -At -F'|' -c "
  SELECT current_user, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
         has_database_privilege(current_database(), 'CREATE'), has_schema_privilege('public', 'CREATE'),
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
             AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                  OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE')))
    FROM pg_roles r WHERE r.rolname = current_user")
[[ "$ROLLE" == "${QUELLE_USER}|f|f|f|f|f|0" ]] || fail "Prod-Rolle ist nicht die reine Leserolle ${QUELLE_USER} (gefunden: ${ROLLE%%|*}, Rechte zu weit)"
say "Prod-Verbindung: $(quelle psql -X -At -c "SELECT current_user || ' @ ' || current_database() || ' (' || inet_server_addr() || ')'" 2>/dev/null || echo "$QUELLE_USER")"

# ── 1. Staging anlegen (nur der Admin darf verbinden) ─────────────────────
msql postgres -c "DROP DATABASE IF EXISTS ${STAGING} WITH (FORCE)"
msql postgres -c "CREATE DATABASE ${STAGING}"
msql postgres -c "REVOKE ALL ON DATABASE ${STAGING} FROM PUBLIC"
# pg_dump --schema=public legt das Schema selbst an (CREATE SCHEMA public).
msql "$STAGING" -c "DROP SCHEMA public CASCADE"

# ── 2. Snapshot öffnen, Stichtag + Zeilenzahlen Prod im selben Snapshot ───
SNAP_DIR=$(mktemp -d); IN="$SNAP_DIR/in"; OUT="$SNAP_DIR/out"; mkfifo "$IN"
quelle psql -X -q -At -v ON_ERROR_STOP=1 <"$IN" >"$OUT" 2>"$SNAP_DIR/err" &
SNAP_PID=$!
exec 7>"$IN"
cat >&7 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'SNAP=' || pg_export_snapshot();
SELECT 'STICHTAG=' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SQL
warte() { for _ in $(seq 1 600); do grep -q "^$1" "$OUT" 2>/dev/null && return 0; kill -0 "$SNAP_PID" 2>/dev/null || break; sleep 0.1; done; cat "$SNAP_DIR/err" >&2; fail "Snapshot-Sitzung antwortet nicht ($1)"; }
warte "STICHTAG="
SNAP=$(grep '^SNAP=' "$OUT" | cut -d= -f2); STICHTAG=$(grep '^STICHTAG=' "$OUT" | cut -d= -f2)
say "Snapshot ${SNAP} · Stichtag ${STICHTAG}"

say "pg_dump → ${STAGING} …"
# `SET transaction_timeout` schreibt pg_dump ab Version 17; ein älterer Mirror-Server
# kennt den Parameter nicht. Für den Import ohne Bedeutung — die eine Zeile fällt weg.
STATS_OPT=(); (( D_VER >= 18 )) && STATS_OPT=(--no-statistics)
quelle pg_dump --snapshot="$SNAP" --schema=public --no-owner --no-privileges --no-comments "${STATS_OPT[@]}" -Fp \
  | sed '/^SET transaction_timeout = /d' \
  | msql "$STAGING" -o /dev/null
say "Import fertig."
# Materialized Views würden beim Import aus ROHdaten gefüllt und an cc_readonly
# freigegeben; Tabellen namens mirror_* fielen aus allen Prüfungen (S-5). Beides sperren.
SPERR=$(msql "$STAGING" -At -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND (c.relkind = 'm' OR (c.relkind IN ('r','p','v','f') AND c.relname LIKE 'mirror\_%'))")
[[ "$SPERR" == "0" ]] || fail "Prod enthält Materialized Views oder Objekte namens mirror_* — erst klären"

# Zeilenzahlen und Stichprobe Prod — im Snapshot, per Katalog (keine Hilfsfunktion in Prod anlegen).
{
  echo "SELECT 'Z|' || c.relname || '|' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text"
  echo "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname;"
  for t in budget_allocations budget_transactions invoices appointments; do
    echo "SELECT 'K|${t}|' || count(*) FROM public.${t} WHERE customer_id = ${STICHPROBE_KUNDE};"
  done
  echo "SELECT 'ENDE';"
  echo "COMMIT;"
} >&7
warte "ENDE"
exec 7>&-; wait "$SNAP_PID" || true; SNAP_PID=""
grep '^Z|' "$OUT" | cut -d'|' -f2,3 >"$SNAP_DIR/prod_zeilen"
grep '^K|' "$OUT" | cut -d'|' -f2,3 >"$SNAP_DIR/prod_k"

# ── 3. Hilfsobjekte, Namen für die Gegenprobe, Zeilenzahlen vorher ────────
msql "$STAGING" -f scripts/mirror/hilfen.sql
msql "$STAGING" <<'SQL'
CREATE TABLE mirror_pruef_namen AS
  SELECT DISTINCT lower(t) AS token FROM (
    SELECT regexp_split_to_table(coalesce(name,'') || ' ' || coalesce(vorname,'') || ' ' || coalesce(nachname,''), '[^[:alpha:]]+') FROM customers
    UNION ALL SELECT regexp_split_to_table(coalesce(vorname,'') || ' ' || coalesce(nachname,'') || ' ' || coalesce(display_name,''), '[^[:alpha:]]+') FROM users
    UNION ALL SELECT regexp_split_to_table(coalesce(vorname,'') || ' ' || coalesce(nachname,''), '[^[:alpha:]]+') FROM customer_contacts
    UNION ALL SELECT regexp_split_to_table(coalesce(vorname,'') || ' ' || coalesce(nachname,''), '[^[:alpha:]]+') FROM prospects
    UNION ALL SELECT regexp_split_to_table(coalesce(lead_name,''), '[^[:alpha:]]+') FROM scheduled_calls
    UNION ALL SELECT regexp_split_to_table(coalesce(notfallkontakt_name,''), '[^[:alpha:]]+') FROM users
    UNION ALL SELECT regexp_split_to_table(coalesce(ansprechpartner,'') || ' ' || coalesce(empfaenger_zeile2,''), '[^[:alpha:]]+') FROM insurance_providers
  ) x(t)
  WHERE length(t) >= 4;
SQL
msql "$STAGING" -At -F'|' -c "SELECT * FROM mirror_zeilen()" >"$SNAP_DIR/import_zeilen"
if ! diff -q "$SNAP_DIR/prod_zeilen" "$SNAP_DIR/import_zeilen" >/dev/null; then
  diff "$SNAP_DIR/prod_zeilen" "$SNAP_DIR/import_zeilen" >&2 || true
  fail "Zeilenzahlen nach dem Import weichen von Prod (Snapshot) ab"
fi

# ── 4. Pseudonymisieren (bricht ab bei jeder nicht zugeordneten Spalte) ───
msql "$STAGING" -At -F'|' -c "
  SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
    FROM information_schema.columns c
    JOIN pg_class k ON k.relname = c.table_name
    JOIN pg_namespace ns ON ns.oid = k.relnamespace AND ns.nspname = 'public'
   WHERE c.table_schema = 'public' AND k.relkind IN ('r','p') AND c.table_name NOT LIKE 'mirror\_%'
   ORDER BY 1, 2" >"$SNAP_DIR/spalten"
python3 scripts/mirror/pseudonymisierung_sql.py <"$SNAP_DIR/spalten" >"$SNAP_DIR/pseudo.sql" \
  || fail "Spaltenliste unvollständig (siehe oben)"
say "Pseudonymisiere $(grep -c '^UPDATE' "$SNAP_DIR/pseudo.sql") Tabellen …"
{ echo "BEGIN; SET LOCAL session_replication_role = replica;"; cat "$SNAP_DIR/pseudo.sql"; echo "COMMIT;"; } | msql "$STAGING"

# ── 5. Prüfen (Abnahme 1–3) ───────────────────────────────────────────────
msql "$STAGING" -At -F'|' -c "SELECT * FROM mirror_zeilen()" >"$SNAP_DIR/mirror_zeilen"
diff -q "$SNAP_DIR/prod_zeilen" "$SNAP_DIR/mirror_zeilen" >/dev/null || fail "Abnahme 1: Zeilenzahlen nach Pseudonymisierung ≠ Prod"
say "Abnahme 1: $(wc -l <"$SNAP_DIR/mirror_zeilen") Tabellen, Zeilenzahlen = Prod (Snapshot)."

TREFFER=$(msql "$STAGING" -At -F' ' -c "SELECT tabelle || '.' || spalte, art, anzahl FROM mirror_suche()")
if [[ -n "$TREFFER" ]]; then say "$TREFFER"; fail "Abnahme 3: Klarnamen/E-Mail/IBAN im Mirror gefunden (nur Spalten und Anzahl gezeigt)"; fi
say "Abnahme 3: $(msql "$STAGING" -At -c "SELECT count(*) FROM mirror_pruef_namen") Namens-Token, E-Mail- und IBAN-Muster — 0 Treffer."

for zeile in $(cat "$SNAP_DIR/prod_k"); do
  t="${zeile%%|*}"; n_prod="${zeile##*|}"
  n_mirror=$(msql "$STAGING" -At -c "SELECT count(*) FROM public.${t} WHERE customer_id = ${STICHPROBE_KUNDE}")
  [[ "$n_prod" == "$n_mirror" ]] || fail "Abnahme 2: Kunde ${STICHPROBE_KUNDE} ${t}: Prod ${n_prod} ≠ Mirror ${n_mirror}"
  say "Abnahme 2: Kunde ${STICHPROBE_KUNDE} ${t}: ${n_mirror} Zeilen (= Prod)"
done
say "Abnahme 2: Kunde ${STICHPROBE_KUNDE} heißt im Mirror „$(msql "$STAGING" -At -c "SELECT name FROM customers WHERE id = ${STICHPROBE_KUNDE}")“."

# ── 6. Stichtag, Hilfsobjekte weg, ersetzen, Leserechte ───────────────────
MANIFEST_SHA=$(sha256sum scripts/mirror/spalten.tsv | cut -c1-16)
COMMIT_ID=$(git rev-parse --short HEAD 2>/dev/null || echo unbekannt)
msql "$STAGING" -v stichtag="$STICHTAG" -v qhost="$QUELLE_HOST" -v qdb="$QUELLE_DB" -v qver="$Q_VER" \
     -v commit="$COMMIT_ID" -v manifest="$MANIFEST_SHA" <<'SQL'
DROP TABLE mirror_pruef_namen;
DROP FUNCTION mirror_scrub(jsonb);
DROP FUNCTION mirror_suche();
CREATE TABLE mirror_meta (
  stichtag timestamptz NOT NULL, quelle_host text NOT NULL, quelle_db text NOT NULL,
  quelle_server_version text NOT NULL, skript_commit text NOT NULL, spaltenliste_sha256 text NOT NULL,
  erstellt_am timestamptz NOT NULL DEFAULT now());
INSERT INTO mirror_meta (stichtag, quelle_host, quelle_db, quelle_server_version, skript_commit, spaltenliste_sha256)
  VALUES (:'stichtag', :'qhost', :'qdb', :'qver', :'commit', :'manifest');
CREATE TABLE mirror_meta_zeilen AS SELECT * FROM mirror_zeilen();
DROP FUNCTION mirror_zeilen();
SQL
# Tote Tupel mit Rohwerten physisch entfernen (Notiz Gate 2 zu #198); bei der Datengröße billig.
msql "$STAGING" -c "VACUUM (FULL, ANALYZE)"

# Ersetzen ohne Lücke: alter Mirror → _alt, Staging → Mirror, dann _alt löschen.
# Scheitert der zweite Schritt, wird _alt zurückbenannt (Notiz Gate 2 zu #198).
ALT="${MIRROR_DB}_alt"
msql postgres -c "DROP DATABASE IF EXISTS ${ALT} WITH (FORCE)"
HATTE_ALT=$(msql postgres -At -c "SELECT count(*) FROM pg_database WHERE datname = '${MIRROR_DB}'")
if [[ "$HATTE_ALT" == "1" ]]; then
  msql postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MIRROR_DB}' AND pid <> pg_backend_pid()" >/dev/null
  msql postgres -c "ALTER DATABASE ${MIRROR_DB} RENAME TO ${ALT}"
fi
if ! msql postgres -c "ALTER DATABASE ${STAGING} RENAME TO ${MIRROR_DB}"; then
  [[ "$HATTE_ALT" == "1" ]] && msql postgres -c "ALTER DATABASE ${ALT} RENAME TO ${MIRROR_DB}" || true
  fail "Umbenennen gescheitert — voriger Mirror wiederhergestellt"
fi
msql postgres -c "DROP DATABASE IF EXISTS ${ALT} WITH (FORCE)"
msql postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIRROR_LESER}') THEN
    CREATE ROLE ${MIRROR_LESER} LOGIN;
  END IF;
END \$\$;
ALTER ROLE ${MIRROR_LESER} SET default_transaction_read_only = on;
REVOKE ALL ON DATABASE ${MIRROR_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${MIRROR_DB} TO ${MIRROR_LESER};
SQL
ERFOLG=1
msql "$MIRROR_DB" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${MIRROR_LESER};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${MIRROR_LESER};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${MIRROR_LESER};
SQL
rm -rf "$SNAP_DIR"
say ""
say "FERTIG: ${MIRROR_DB} ersetzt · Stichtag ${STICHTAG} · Skript ${COMMIT_ID} · Spaltenliste ${MANIFEST_SHA}"
