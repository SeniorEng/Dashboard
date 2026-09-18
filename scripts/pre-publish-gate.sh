#!/usr/bin/env bash
#
# Riegel VOR dem Publish (Ticket 6hWvMvpxpJFFjwQG, Frage 2).
#
# ── Warum es diesen Schritt gibt ──────────────────────────────────────────
# Auf dem Replit-Pfad kann `scripts/migrate.sh` kein Riegel sein: es läuft im
# BUILD, und Replits eigene Schema-Phase läuft DAVOR. Gemessen am 18.09.2026
# aus Replit-Doku und Migrations-Blogpost: die Phase diffed Dev-DB gegen
# Prod-DB per direkter Introspektion, beim Deploy-Start, und WARNT bei
# Destruktivem nur, statt zu blockieren. Abschalten ist nicht dokumentiert.
#
# Also bleibt nur, VOR dem Drücken nachzusehen — mit genau dem Vergleich, den
# die Plattform danach anstellt. `script/schema-replica-diff.mjs` macht genau
# das (Dev-DB gegen Prod-Replica) und braucht dafür ZWEI Abfragen; deshalb
# läuft es gegen Prod, wo `drizzle-kit push` mit 420 Katalog-Abfragen abbricht
# (6hWvrJgff5xr9hfp).
#
# ── Was dieses Skript ERSETZT ─────────────────────────────────────────────
#  1. Den kopierten `node --input-type=module -e "…"`-Block vom 17.09.2026.
#     Er ist bei Alrik DREIMAL gescheitert, und zwei der drei Gründe waren
#     Eigenschaften des Blocks, nicht der Umgebung:
#       - `!r.available` in doppelten Quotes → History-Expansion in der
#         interaktiven Shell (`event not found`). Lief bei CC durch, weil
#         nicht-interaktive Shells keine History-Expansion machen.
#       - `'<prod-url>'` blieb als Platzhalter stehen → `ENOTFOUND base`.
#     Eine Datei im Repo hat beide Probleme nicht: sie wird nicht getippt.
#  2. Den Handgriff „Replits Schema-Phase im Publish-Dialog aufklappen und
#     hinsehen". Der hat am 17.09. gerettet — aber als Handgriff, nicht als
#     Zusage. Ein Handgriff, an den sich jemand erinnern muss, ist kein Gate.
#
# ── Aufruf ────────────────────────────────────────────────────────────────
#   bash scripts/pre-publish-gate.sh
#
# Die Prod-URL kommt aus `PROD_DATABASE_URL` oder aus der Datei `.prod-url.txt`
# (gitignored). Sie wird NIE ausgegeben — gemeldet werden Host und
# `current_database()` aus der offenen Verbindung.
#
# NUR LESEND. Dieses Skript schreibt nichts, weder in Dev noch in Prod.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

URL_DATEI=".prod-url.txt"

fehler() {
  echo "" >&2
  echo "ABBRUCH: $1" >&2
  echo "" >&2
  exit 1
}

echo "Pre-Publish-Gate"
echo "================"
echo ""

# ── 1. Prod-URL beschaffen ────────────────────────────────────────────────
# Zuerst, weil ohne sie nichts geht — und ohne Netzzugriff feststellbar.
if [[ -n "${PROD_DATABASE_URL:-}" ]]; then
  echo "[1/4] Prod-URL: aus der Umgebung übernommen."
elif [[ -f "$URL_DATEI" ]]; then
  # `git check-ignore` statt eines Greps in `.gitignore`: es beantwortet die
  # Frage, die zählt („würde git diese Datei aufnehmen?"), und nicht die Frage,
  # ob irgendwo ein passendes Muster steht.
  if ! git check-ignore -q "$URL_DATEI"; then
    fehler "$URL_DATEI ist NICHT gitignored — eine Prod-Zugangsdatei darf nie in einen Commit geraten."
  fi
  PROD_DATABASE_URL="$(tr -d '[:space:]' < "$URL_DATEI")"
  [[ -n "$PROD_DATABASE_URL" ]] || fehler "$URL_DATEI ist leer."
  echo "[1/4] Prod-URL: aus $URL_DATEI gelesen (gitignored, wird nicht ausgegeben)."
else
  echo "Die Prod-URL fehlt. Sie steht im Replit-Publishing-Tab unter „Environment“." >&2
  echo "" >&2
  echo "So hinterlegen — der Wert wird eingefügt, nicht getippt, und landet" >&2
  echo "dadurch weder in der Shell-History noch in einem Commit:" >&2
  echo "" >&2
  echo "    cat > $URL_DATEI" >&2
  echo "    <URL einfügen, dann Enter, dann Strg-D>" >&2
  echo "" >&2
  fehler "keine Prod-URL."
fi
export PROD_DATABASE_URL

[[ -n "${DATABASE_URL:-}" ]] || fehler "DATABASE_URL ist nicht gesetzt — ohne die Dev-Seite gibt es nichts zu vergleichen."

# ── 2. Steht der Workspace auf dem Stand, der deployt wird? ───────────────
# Replit deployt den WORKSPACE, nicht origin/main. Ein Workspace hinter main
# liefert also alten Code aus — und der Vergleich weiter unten liest die
# Contract-Allowlist aus genau diesem Checkout. Am 17.09. war das der real
# eingetretene Fall: `HEAD` kannte #146 nicht, `origin/main` schon.
echo "[2/4] Workspace-Stand gegen origin/main …"
git fetch -q origin main 2>/dev/null || fehler "git fetch fehlgeschlagen — ohne origin/main ist der Stand nicht prüfbar."
HEAD_SHA="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse origin/main)"
if [[ "$HEAD_SHA" != "$MAIN_SHA" ]]; then
  echo "" >&2
  echo "  Lokal, aber nicht auf origin/main:" >&2
  git log --oneline origin/main..HEAD | sed 's/^/    /' >&2 || true
  echo "  Auf origin/main, aber nicht lokal:" >&2
  git log --oneline HEAD..origin/main | sed 's/^/    /' >&2 || true
  fehler "Workspace weicht von origin/main ab. Erst auflösen — sonst deployt der Publish etwas anderes als gemessen wird."
fi
echo "      HEAD == origin/main ($(git rev-parse --short HEAD))."

# ── 3. Läuft der Release-Step überhaupt mit? ──────────────────────────────
# WARNT, blockiert NICHT — und das ist Absicht: seit dem 17.09. läuft die
# Build-Zeile bewusst ohne `migrate.sh`, weil Schritt 0d gegen Prod nicht
# durchkommt (6hWvrJgff5xr9hfp). Würde dieser Riegel deshalb blockieren, wäre
# er genau dann unbenutzbar, wenn er am meisten gebraucht wird.
echo "[3/4] .replit-Build-Zeile …"
if grep -q "migrate.sh" .replit 2>/dev/null; then
  echo "      Release-Step ist verdrahtet."
else
  # Einfache Quotes: in doppelten wären die Backticks um migrate.sh eine
  # Kommando-Substitution — das Skript würde den Release-Step AUSFÜHREN, statt
  # über ihn zu reden. Genau der Fehler, der am 17.09. eine Commit-Nachricht
  # zerlegt hat.
  echo '      ACHTUNG: die Build-Zeile ruft `migrate.sh` NICHT auf.'
  echo "          Dieser Publish läuft ohne Identitätsriegel (0a), ohne"
  echo "          DROP-Trockenlauf (0d), ohne Nachbedingung (1b) und ohne"
  echo "          Datenstand-Prüfung (0e/2). Ticket: 6hWvrJgff5xr9hfp."
  echo "          Dieser Vor-Riegel ersetzt davon nur den DROP-Teil."
fi

# ── 4. Die Checkliste — sie entscheidet über den Exit-Code ────────────────
# `script/preflight-publish.mjs` beendet sich mit ≠0, sobald ein automatischer
# Check fehlschlägt; „nicht gemessen" zählt seit #147 als Fehlschlag, nicht als
# Häkchen. Der Exit-Code dieses Skripts ist seiner.
echo "[4/4] Schema-Diff gegen Prod + Backup-Lage:"
node script/preflight-publish.mjs
