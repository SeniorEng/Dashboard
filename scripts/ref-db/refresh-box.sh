#!/usr/bin/env bash
#
# Referenz-DB auf der Box einspielen — Schritt 6 der Pipeline aus
# `build-ref-db.md`, plus der Refresh-Zeitstempel.
#
# ── Was dieses Skript NICHT tut ─────────────────────────────────────────────
# Es holt den Dump NICHT. Von der Box aus ist Replit nicht erreichbar (siehe
# build-ref-db.md, Schritt 5) — der Transfer geht immer von Replit ZUR Box.
# Dieses Skript findet also nur den neuesten bereits angekommenen Dump und
# spielt ihn ein. Das ist der halbautomatische Teil; den Auslöser stellt
# `refresh-replit.sh` auf der anderen Seite.
#
# ── Warum der Zeitstempel hier gesetzt wird ─────────────────────────────────
# Weil `pg_restore` die Datenbank vorher wegwirft. Jeder Stempel, der VOR dem
# Restore geschrieben wird, überlebt ihn nicht. Er gehört deshalb unmittelbar
# hinter den Restore — und in die Datenbank selbst, nicht in eine Datei
# daneben: so reist er mit, und ein Analyse-Skript kann ihn lesen, ohne das
# Dateisystem zu kennen.
#
# Aufruf (idempotent, beliebig oft wiederholbar):
#   bash scripts/ref-db/refresh-box.sh [pfad/zum/dump]
#
# Ohne Argument wird der neueste `engeldesk-ref-*.dump` in $HOME genommen.

set -euo pipefail

REF_DB="${REF_DB_NAME:-engeldesk_ref}"
DUMP="${1:-}"

if [ -z "$DUMP" ]; then
  DUMP="$(ls -t "$HOME"/engeldesk-ref-*.dump 2>/dev/null | head -1 || true)"
fi

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "ABBRUCH: kein Dump gefunden." >&2
  echo "  Gesucht: \$1 oder neuester \$HOME/engeldesk-ref-*.dump" >&2
  echo "  Der Transfer geht von Replit zur Box — siehe build-ref-db.md Schritt 5." >&2
  exit 2
fi

# Die Herkunft des Stempels ist der Dump-Name, nicht `now()`: der Dump traegt
# das Datum seiner ERZEUGUNG. Wird ein alter Dump erneut eingespielt, soll der
# Stempel das sagen und nicht so tun, als waere der Stand frisch.
DUMP_NAME="$(basename "$DUMP")"
DUMP_DATE="$(echo "$DUMP_NAME" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 || true)"
if [ -z "$DUMP_DATE" ]; then
  echo "ABBRUCH: aus '$DUMP_NAME' laesst sich kein Datum lesen (erwartet YYYY-MM-DD)." >&2
  echo "  Ohne Erzeugungsdatum waere der Stempel eine Behauptung." >&2
  exit 2
fi

echo "Dump:      $DUMP"
echo "Erzeugt:   $DUMP_DATE"
echo "Ziel-DB:   $REF_DB"
echo

psql -c "DROP DATABASE IF EXISTS ${REF_DB}"
psql -c "CREATE DATABASE ${REF_DB}"
pg_restore -d "$REF_DB" --no-owner --no-privileges "$DUMP"

# Einzeilige Meta-Tabelle. Der `CHECK (id)` auf einer Boolean-Spalte erzwingt
# genau eine Zeile — ohne ihn sammelten sich Stempel an und „der letzte" waere
# eine Frage der Sortierung statt eine Tatsache.
psql -d "$REF_DB" <<SQL
CREATE TABLE IF NOT EXISTS ref_db_meta (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_refresh_at  timestamptz NOT NULL,
  source_dump_name text        NOT NULL
);
INSERT INTO ref_db_meta (id, last_refresh_at, source_dump_name)
VALUES (true, '${DUMP_DATE}T00:00:00Z'::timestamptz, '${DUMP_NAME}')
ON CONFLICT (id) DO UPDATE
  SET last_refresh_at  = EXCLUDED.last_refresh_at,
      source_dump_name = EXCLUDED.source_dump_name;

COMMENT ON DATABASE ${REF_DB} IS
  'Pseudonymisierte Prod-Kopie. Stand: ${DUMP_DATE}. Siehe ref_db_meta.';
SQL

echo
echo "Eingespielt. Stand laut ref_db_meta:"
psql -d "$REF_DB" -Atc "SELECT last_refresh_at || '  (' || source_dump_name || ')' FROM ref_db_meta"

# Gegenprobe, dass der Scrub wirklich gelaufen ist. Ein unbereinigter Dump auf
# der Box waere ein PII-Vorfall, kein Schoenheitsfehler — und er faellt sonst
# erst auf, wenn jemand die Daten ansieht.
#
# Geprueft wird gegen das, was `scrub-pii.sql` TATSAECHLICH schreibt
# (`vorname = 'Kunde'`, `nachname = id::text`), nicht gegen eine Vermutung
# darueber. Faellt der Scrub aus, stehen dort Klarnamen und die Zahl ist > 0.
echo
echo "PII-Gegenprobe — Kunden mit NICHT pseudonymisiertem Namen (erwartet: 0):"
UNSCRUBBED=$(psql -d "$REF_DB" -Atc "
  SELECT count(*) FROM customers
  WHERE vorname IS DISTINCT FROM 'Kunde'
     OR nachname IS DISTINCT FROM id::text
")
echo "  $UNSCRUBBED"

if [ "$UNSCRUBBED" != "0" ]; then
  echo >&2
  echo "ABBRUCH: $UNSCRUBBED Kunden tragen keinen pseudonymisierten Namen." >&2
  echo "  Der Dump ist offenbar NICHT gescrubbt. Die Datenbank wird verworfen," >&2
  echo "  damit kein Roh-PII auf der Box liegenbleibt." >&2
  psql -c "DROP DATABASE IF EXISTS ${REF_DB}"
  exit 2
fi

echo
echo "Fertig. Analyse-Skripte koennen jetzt gegen ${REF_DB} messen."
