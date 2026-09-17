#!/usr/bin/env bash
#
# Referenz-DB erzeugen und zur Box schicken — Schritte 1 bis 5 der Pipeline
# aus `build-ref-db.md`, am Stück und unbeaufsichtigt fahrbar.
#
# ── Warum dieses Skript auf REPLIT laufen muss ──────────────────────────────
# Weil der Scrub dort laufen muss. Designprinzip der Pipeline:
# pseudonymisiert an der Quelle — nur die bereinigte Datei reist. Ein Cron auf
# der Hetzner-Box kann den Refresh deshalb NICHT ziehen; von der Box aus ist
# Replit ohnehin nicht erreichbar (build-ref-db.md, Schritt 5). Der Auslöser
# gehört auf die Replit-Seite, das Einspielen macht drüben `refresh-box.sh`.
#
# ── Was es NICHT tut ────────────────────────────────────────────────────────
# Es fasst Prod nicht schreibend an. Schritt 1 ist ein `pg_dump` und sonst
# nichts; alles Weitere passiert in der Wegwerf-DB `ref_build`.
#
# Aufruf:
#   PROD_DATABASE_URL=… BOX_SSH_TARGET=dev@engeldesk-01 \
#     bash scripts/ref-db/refresh-replit.sh
#
# Für den Cron zusätzlich `--quiet` (unterdrückt Fortschritt, Fehler bleiben).

set -euo pipefail

BUILD_DB="${REF_BUILD_DB:-ref_build}"
BOX="${BOX_SSH_TARGET:-}"
STAMP="$(date +%F)"
OUT="engeldesk-ref-${STAMP}.dump"
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { [ "${1:-}" = "--quiet" ] || echo "$@"; }

if [ -z "${PROD_DATABASE_URL:-}" ]; then
  echo "ABBRUCH: PROD_DATABASE_URL ist nicht gesetzt." >&2
  exit 2
fi
if [ -z "$BOX" ]; then
  echo "ABBRUCH: BOX_SSH_TARGET ist nicht gesetzt (z.B. dev@engeldesk-01)." >&2
  echo "  Ohne Ziel entstuende ein Dump, der nirgends ankommt — und niemand" >&2
  echo "  merkte es, weil die Box einfach den alten Stand behielte." >&2
  exit 2
fi

# ── Schritt 1: Prod-Dump in die Wegwerf-DB ─────────────────────────────────
say "[1/5] Prod-Dump nach ${BUILD_DB} ..."
dropdb --if-exists "$BUILD_DB"
createdb "$BUILD_DB"
pg_dump "$PROD_DATABASE_URL" --no-owner --no-privileges | psql -q "$BUILD_DB"

# ── Schritt 2: Scrub ───────────────────────────────────────────────────────
# Laeuft als EINE Transaktion (`ON_ERROR_STOP`): bricht ein Block ab, ist
# NICHTS bereinigt — und der Verify in Schritt 3 faengt das. Ein halb
# gescrubbter Dump waere der gefaehrlichste Ausgang.
say "[2/5] Scrub ..."
psql -q -v ON_ERROR_STOP=1 -d "$BUILD_DB" -f "${HIER}/scrub-pii.sql"

# ── Schritt 3: Verifikation, PFLICHT ───────────────────────────────────────
# Ohne dieses Gate ist die Automatisierung gefaehrlicher als der Handbetrieb:
# beim Handlauf sieht ein Mensch hin, hier sieht niemand hin.
say "[3/5] Verifikation ..."
UNSCRUBBED=$(psql -Atc "
  SELECT count(*) FROM customers
  WHERE vorname IS DISTINCT FROM 'Kunde'
     OR nachname IS DISTINCT FROM id::text
" -d "$BUILD_DB")

if [ "$UNSCRUBBED" != "0" ]; then
  echo "ABBRUCH: $UNSCRUBBED Kunden sind nicht pseudonymisiert." >&2
  echo "  Der Dump wird NICHT erzeugt und NICHTS verlaesst Replit." >&2
  dropdb --if-exists "$BUILD_DB"
  exit 2
fi

# Gegenrichtung: der Scrub darf nicht so gruendlich sein, dass keine Daten
# mehr da sind. Eine leergeraeumte Ref-DB besteht jeden PII-Test und ist
# wertlos — genau die Falle des 64.837,30-€-Artefakts vom 02.09.2026.
KUNDEN=$(psql -Atc "SELECT count(*) FROM customers WHERE deleted_at IS NULL" -d "$BUILD_DB")
TERMINE=$(psql -Atc "SELECT count(*) FROM appointments WHERE deleted_at IS NULL" -d "$BUILD_DB")
if [ "$KUNDEN" -lt 50 ] || [ "$TERMINE" -lt 500 ]; then
  echo "ABBRUCH: die bereinigte DB wirkt leer (Kunden=$KUNDEN, Termine=$TERMINE)." >&2
  echo "  Ein leerer Stand besteht jeden PII-Test und beantwortet keine Frage." >&2
  dropdb --if-exists "$BUILD_DB"
  exit 2
fi
say "      Kunden=${KUNDEN} Termine=${TERMINE} — plausibel."

# ── Schritt 4: Dump der bereinigten DB ─────────────────────────────────────
say "[4/5] Dump ${OUT} ..."
pg_dump "$BUILD_DB" --no-owner --no-privileges -Fc -f "$OUT"

# ── Schritt 5: Transfer ────────────────────────────────────────────────────
say "[5/5] Transfer nach ${BOX} ..."
scp -q "$OUT" "${BOX}:/home/dev/"

# Aufraeumen: der Roh-Dump aus Schritt 1 steckt in `ref_build` und darf nicht
# liegenbleiben. Die bereinigte Datei bleibt fuer eine Runde liegen, damit ein
# fehlgeschlagener Transfer nachholbar ist.
dropdb --if-exists "$BUILD_DB"
find . -maxdepth 1 -name 'engeldesk-ref-*.dump' -mtime +3 -delete

say "Fertig. Auf der Box einspielen:"
say "  bash scripts/ref-db/refresh-box.sh"
