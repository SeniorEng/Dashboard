#!/usr/bin/env bash
#
# prune-git-object-bloat.sh — aufgeblähtes .git entschlacken (Task #1904)
#
# Problem: Gits automatische Hintergrundwartung (`git maintenance`) legt vor dem
# Lauf `.git/objects/maintenance.lock` an und entfernt die Datei danach wieder.
# Bricht ein Lauf hart ab (Container-Kill, Workspace-Neustart), bleibt die Sperre
# liegen — und JEDER weitere Wartungslauf beendet sich ab da sofort und still.
# Lose Objekte werden dann nie mehr zusammengepackt. Stand Task #1904: die Sperre
# lag seit dem 02.06.2026 im Objektspeicher, `.git` war auf 494 MB angewachsen,
# davon 463 MiB in 39.705 LOSEN Objekten (gepackt: nur 7.928 Objekte / 22 MiB),
# dazu 1.054 `subrepl-*`-Branches aus früheren Task-Agent-Läufen (1.089 Refs) und
# ein als Garbage gemeldetes Temp-Objekt. Folge: jede Git-Operation der Workspace-
# Oberfläche (Status, Refs auflisten, Diff) muss durch zehntausende Objekte und
# über tausend Refs — spürbar langsam bis zu Timeouts.
#
# Das Skript räumt genau diese Ursachen auf, ohne Historie umzuschreiben:
#   1. verwaiste `maintenance.lock` entfernen (nur wenn KEIN Wartungsprozess läuft
#      und die Sperre älter als LOCK_MIN_AGE_MIN Minuten ist)
#   2. `subrepl-*`-Branches abräumen — aber NIE allein nach Alter (siehe unten)
#   3. `git gc` (Default-Prune-Fenster 2 Wochen) — lose Objekte wandern in Packs
#
# ---------------------------------------------------------------------------
# Umgang mit den Agent-Branches: löschen nur mit Beweis, sonst Friedhof
# ---------------------------------------------------------------------------
# Ein altes Commit-Datum ist KEIN Beleg dafür, dass die Arbeit eines Branches
# gemergt ist — ein lange ruhender, aber noch relevanter Branch sähe genauso aus.
# Deshalb wird jeder Kandidat klassifiziert:
#
#   INTEGRIERT  — die Spitze ist von einem erhaltenen Ref aus erreichbar ODER ihr
#                 BAUM (der komplette Dateistand) kommt in der Historie eines
#                 erhaltenen Refs vor. Der Inhalt liegt damit nachweislich schon
#                 woanders ⇒ der Branch wird gelöscht.
#   UNGEPRÜFT   — alles andere. Wird NICHT gelöscht, sondern unter
#                 `refs/subrepl-graveyard/<name>` als echter Backup-Ref abgelegt
#                 und dann aus `refs/heads/` entfernt. Der Ref hält die Objekte
#                 dauerhaft am Leben (`git gc` fasst sie nicht an), die
#                 Wiederherstellung ist ein Einzeiler:
#                     git branch <name> refs/subrepl-graveyard/<name>
#                 Aus der Branch-Liste (und damit aus der Git-Oberfläche) sind sie
#                 trotzdem raus.
#
# Der Friedhof läuft NICHT von selbst ab. Ein Eintrag verschwindet nur, wenn er
# inzwischen nachweislich integriert ist (Beweis, nicht Zeit) — oder wenn jemand
# `--expire-graveyard` bewusst aufruft (löscht Einträge älter als
# GRAVEYARD_TTL_DAYS). Der Post-Merge-Hook ruft das NICHT auf; der einzige
# unumkehrbare Schritt bleibt damit eine bewusste Handlung.
#
# Zusätzlich schützen zwei Gates: (a) ein AUSGECHECKTER Branch ist immer tabu —
# der HEAD dieses Verzeichnisses und jeder in einem verlinkten Worktree
# ausgecheckte Branch, unabhängig von Alter und Klassifikation; (b) Branches,
# deren Spitze jünger als PRUNE_AGE_DAYS Tage ist, werden gar nicht erst
# angefasst. Der Branch des gerade laufenden Task-Environments bleibt damit auch
# dann in Ruhe, wenn seine Spitze längst alt ist.
#
# Was NIE angefasst wird: `main`, `replit-agent`, `replit-safety-*`, jedes andere
# nicht-`subrepl-*`-Local-Branch, alle Remote-Refs (`refs/remotes/*`), Tags und
# Notes. Kein Rewrite, kein Shallow-Clone, kein Force-Push, kein `--prune=now`
# (unerreichbare Objekte jünger als 2 Wochen bleiben als Netz liegen).
#
# Idempotent: ohne Ballast ein No-Op mit Exit 0.
#
# Nutzung:
#   bash scripts/prune-git-object-bloat.sh                     # Trockenlauf (Default)
#   bash scripts/prune-git-object-bloat.sh --apply             # aufräumen
#   bash scripts/prune-git-object-bloat.sh --list-unverified   # Friedhof-Kandidaten zeigen
#   bash scripts/prune-git-object-bloat.sh --apply --expire-graveyard
#                                                              # Friedhof endgültig leeren
#                                                              # (nur Einträge > GRAVEYARD_TTL_DAYS)
#
# Läuft zusätzlich best-effort in scripts/post-merge.sh (ohne --expire-graveyard).
# Wichtig: die Bereinigung wirkt immer nur auf das `.git` der Umgebung, in der sie
# läuft — der Objektspeicher ist kein versionierter Inhalt und wandert nicht über
# einen Task-Merge mit. Ein Task-Agent kann das Haupt-Repl also nur über diesen
# Post-Merge-Hook (oder der Nutzer manuell in der Shell) entschlacken.

set -euo pipefail

APPLY=0
EXPIRE_GRAVEYARD=0
LIST_UNVERIFIED=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --expire-graveyard) EXPIRE_GRAVEYARD=1 ;;
    --list-unverified) LIST_UNVERIFIED=1 ;;
    *) printf 'Unbekannte Option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

PRUNE_AGE_DAYS="${PRUNE_AGE_DAYS:-14}"
LOCK_MIN_AGE_MIN="${LOCK_MIN_AGE_MIN:-60}"
LOOSE_OBJECT_THRESHOLD="${LOOSE_OBJECT_THRESHOLD:-5000}"
GRAVEYARD_TTL_DAYS="${GRAVEYARD_TTL_DAYS:-180}"

BRANCH_PREFIX="subrepl-"
GRAVEYARD_NS="refs/subrepl-graveyard"

log() { printf '[git-slim] %s\n' "$*" >&2; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "Kein Git-Repository — nichts zu tun."
  exit 0
fi

GIT_DIR="$(git rev-parse --git-dir)"
workdir="$(mktemp -d)"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

# ---------------------------------------------------------------- Messung ----
loose_count() { git count-objects -v 2>/dev/null | awk '/^count:/ {print $2}'; }
pack_count() { git count-objects -v 2>/dev/null | awk '/^packs:/ {print $2}'; }
garbage_count() { git count-objects -v 2>/dev/null | awk '/^garbage:/ {print $2}'; }
ref_count() { git for-each-ref --format='%(refname)' | wc -l | tr -d ' '; }
head_count() { git for-each-ref --format='%(refname)' refs/heads | wc -l | tr -d ' '; }
graveyard_count() { git for-each-ref --format='%(refname)' "$GRAVEYARD_NS" | wc -l | tr -d ' '; }
dir_size() { du -sh "$GIT_DIR" 2>/dev/null | awk '{print $1}'; }

report() {
  printf '  .git-Größe:       %s\n' "$(dir_size)" >&2
  printf '  lose Objekte:     %s\n' "$(loose_count)" >&2
  printf '  Packs:            %s\n' "$(pack_count)" >&2
  printf '  Garbage-Dateien:  %s\n' "$(garbage_count)" >&2
  printf '  Refs gesamt:      %s\n' "$(ref_count)" >&2
  printf '  lokale Branches:  %s (davon %s*: %s)\n' "$(head_count)" "$BRANCH_PREFIX" \
    "$(git for-each-ref --format='%(refname)' "refs/heads/${BRANCH_PREFIX}*" | wc -l | tr -d ' ')" >&2
  printf '  Friedhof-Refs:    %s\n' "$(graveyard_count)" >&2
}

log "VORHER:"
report
before_loose="$(loose_count)"
before_refs="$(ref_count)"
before_heads="$(head_count)"
before_size="$(dir_size)"

# ------------------------------------------------- laufende Wartung prüfen ----
if pgrep -f 'git( .*)? (maintenance|gc|repack|pack-objects)' >/dev/null 2>&1; then
  log "Ein Git-Wartungsprozess läuft gerade — Abbruch (nichts geändert)."
  exit 0
fi

LOCK_FILE="${GIT_DIR}/objects/maintenance.lock"
stale_lock=0
if [ -e "$LOCK_FILE" ]; then
  if [ -n "$(find "$LOCK_FILE" -mmin "+${LOCK_MIN_AGE_MIN}" 2>/dev/null)" ]; then
    stale_lock=1
    log "Verwaiste Wartungssperre gefunden: ${LOCK_FILE} (seit $(date -r "$LOCK_FILE" '+%Y-%m-%d %H:%M'))"
  else
    log "Wartungssperre ist jünger als ${LOCK_MIN_AGE_MIN} min — bleibt liegen (evtl. aktiver Lauf)."
  fi
fi

# ------------------------------------ Integrations-Beweis: Commits + Bäume ----
# Alles, was NICHT Löschkandidat ist, zählt als "erhalten": main, replit-agent,
# replit-safety-*, sonstige Branches, alle Remote-Refs, Tags, Notes.
keep_refs="$(git for-each-ref --format='%(refname)' refs/heads refs/remotes refs/tags refs/notes refs/replit \
  | grep -v "^refs/heads/${BRANCH_PREFIX}" || true)"
if [ -z "$keep_refs" ]; then
  log "Keine erhaltenen Refs gefunden — Abbruch (Sicherheitsnetz)."
  exit 0
fi
# shellcheck disable=SC2086
git rev-list $keep_refs --format='%H%x09%T' 2>/dev/null | grep -v '^commit ' >"${workdir}/keep.tsv"
cut -f1 "${workdir}/keep.tsv" | sort -u >"${workdir}/keep-commits.txt"
cut -f2 "${workdir}/keep.tsv" | sort -u >"${workdir}/keep-trees.txt"

# classify <sha> <tree> -> "integrated" | "unverified"
classify() {
  if grep -qxF "$1" "${workdir}/keep-commits.txt" || grep -qxF "$2" "${workdir}/keep-trees.txt"; then
    printf 'integrated'
  else
    printf 'unverified'
  fi
}

# --------------------------------------------------- Kandidaten einsortieren --
# Ausgecheckte Branches sind TABU — unabhängig von Alter und Klassifikation. Ein
# `update-ref delete` auf den Branch, auf dem HEAD symbolisch steht, ließe die
# Arbeitskopie mit einem ins Leere zeigenden HEAD zurück. Neben dem HEAD dieses
# Verzeichnisses gilt das auch für jeden Branch, der in einem verlinkten
# Worktree ausgecheckt ist.
: >"${workdir}/protected.txt"
git symbolic-ref -q HEAD >>"${workdir}/protected.txt" || true
git worktree list --porcelain 2>/dev/null | awk '/^branch /{print $2}' >>"${workdir}/protected.txt" || true
sort -u -o "${workdir}/protected.txt" "${workdir}/protected.txt"

cutoff_epoch=$(( $(date +%s) - PRUNE_AGE_DAYS * 86400 ))
: >"${workdir}/integrated.tsv"
: >"${workdir}/unverified.tsv"
kept_young=0
kept_checked_out=0
while IFS=$'\t' read -r ts sha tree fullref name; do
  [ -z "${name:-}" ] && continue
  if grep -qxF "$fullref" "${workdir}/protected.txt"; then
    kept_checked_out=$((kept_checked_out + 1))
    log "  ausgecheckt, unantastbar: ${name}"
    continue
  fi
  if [ "$ts" -ge "$cutoff_epoch" ]; then
    kept_young=$((kept_young + 1))
    continue
  fi
  day="$(date -d "@$ts" '+%Y-%m-%d' 2>/dev/null || echo "$ts")"
  printf '%s\t%s\t%s\n' "$name" "$sha" "$day" >>"${workdir}/$(classify "$sha" "$tree").tsv"
done < <(git for-each-ref \
           --format='%(committerdate:unix)%09%(objectname)%09%(tree)%09%(refname)%09%(refname:short)' \
           "refs/heads/${BRANCH_PREFIX}*")

integrated_count="$(wc -l <"${workdir}/integrated.tsv" | tr -d ' ')"
unverified_count="$(wc -l <"${workdir}/unverified.tsv" | tr -d ' ')"

log "${BRANCH_PREFIX}*-Branches älter als ${PRUNE_AGE_DAYS} Tage: $((integrated_count + unverified_count))"
log "  nachweislich integriert (löschen):       ${integrated_count}"
log "  ungeprüft (in den Friedhof, kein Verlust): ${unverified_count}"
[ "$kept_young" -gt 0 ] && log "  zu jung, gar nicht angefasst:            ${kept_young}"
[ "$kept_checked_out" -gt 0 ] && log "  ausgecheckt, gar nicht angefasst:        ${kept_checked_out}"

if [ "$LIST_UNVERIFIED" -eq 1 ]; then
  log "Ungeprüfte Kandidaten (Name / SHA / Datum):"
  cat "${workdir}/unverified.tsv" >&2
fi

# ---------------------------- Friedhof: inzwischen integrierte Einträge weg ---
: >"${workdir}/graveyard-drop.txt"
: >"${workdir}/graveyard-expire.txt"
gy_cutoff=$(( $(date +%s) - GRAVEYARD_TTL_DAYS * 86400 ))
while IFS=$'\t' read -r ts sha tree refname; do
  [ -z "${refname:-}" ] && continue
  if [ "$(classify "$sha" "$tree")" = "integrated" ]; then
    echo "$refname" >>"${workdir}/graveyard-drop.txt"
  elif [ "$EXPIRE_GRAVEYARD" -eq 1 ] && [ "$ts" -lt "$gy_cutoff" ]; then
    echo "$refname" >>"${workdir}/graveyard-expire.txt"
  fi
done < <(git for-each-ref --format='%(committerdate:unix)%09%(objectname)%09%(tree)%09%(refname)' "$GRAVEYARD_NS")

gy_drop="$(wc -l <"${workdir}/graveyard-drop.txt" | tr -d ' ')"
gy_expire="$(wc -l <"${workdir}/graveyard-expire.txt" | tr -d ' ')"
[ "$gy_drop" -gt 0 ] && log "Friedhof: ${gy_drop} Eintrag/Einträge inzwischen nachweislich integriert — werden freigegeben."
[ "$gy_expire" -gt 0 ] && log "Friedhof: ${gy_expire} Eintrag/Einträge älter als ${GRAVEYARD_TTL_DAYS} Tage — werden per --expire-graveyard endgültig entfernt."

# ------------------------------------------------------------- Trockenlauf ----
if [ "$APPLY" -eq 0 ]; then
  log "TROCKENLAUF (kein --apply): es wird nichts geändert."
  log "Zum Aufräumen: bash scripts/prune-git-object-bloat.sh --apply"
  exit 0
fi

# ------------------------------------------------------- 1. Sperre entfernen --
if [ "$stale_lock" -eq 1 ]; then
  rm -f "$LOCK_FILE"
  log "Wartungssperre entfernt — die automatische Hintergrundwartung läuft wieder."
fi

# ------------------------------------------------------ 2. Refs umsortieren ---
if [ "$((integrated_count + unverified_count))" -gt 0 ]; then
  backup_dir=".local/git-backups"
  mkdir -p "$backup_dir"
  backup_file="${backup_dir}/subrepl-branches.backup-$(date +%Y%m%d-%H%M%S).tsv"
  {
    printf '# Klassifikation\tBranch\tSHA\tDatum\n'
    sed 's/^/integrated\t/' "${workdir}/integrated.tsv"
    sed 's/^/unverified\t/' "${workdir}/unverified.tsv"
  } >"$backup_file"
  log "Protokoll der Änderungen: ${backup_file}"
fi

# Batch über `git update-ref --stdin`: 1000+ einzelne `git branch`-Aufrufe wären
# zehntausende Prozesse. Erst den Friedhofs-Ref anlegen, dann den Branch lösen —
# in EINER Transaktion, damit nie ein Zwischenzustand ohne Ref entsteht.
{
  # a) ungeprüft: Backup-Ref anlegen + Branch entfernen
  while IFS=$'\t' read -r name sha _day; do
    [ -z "${name:-}" ] && continue
    printf 'create %s/%s %s\n' "$GRAVEYARD_NS" "$name" "$sha"
    printf 'delete refs/heads/%s %s\n' "$name" "$sha"
  done <"${workdir}/unverified.tsv"
  # b) nachweislich integriert: nur entfernen
  while IFS=$'\t' read -r name sha _day; do
    [ -z "${name:-}" ] && continue
    printf 'delete refs/heads/%s %s\n' "$name" "$sha"
  done <"${workdir}/integrated.tsv"
  # c) Friedhof: freigeben / abgelaufen
  while read -r refname; do [ -n "$refname" ] && printf 'delete %s\n' "$refname"; done \
    <"${workdir}/graveyard-drop.txt"
  while read -r refname; do [ -n "$refname" ] && printf 'delete %s\n' "$refname"; done \
    <"${workdir}/graveyard-expire.txt"
} | git update-ref --stdin

if [ "$((integrated_count + unverified_count))" -gt 0 ]; then
  log "Gelöscht: ${integrated_count} integrierte Branches; in den Friedhof verschoben: ${unverified_count}."
  log "Verbleibende lokale Branches: $(git branch --list | tr -d ' *' | tr '\n' ' ')"
  [ "$unverified_count" -gt 0 ] && \
    log "Wiederherstellen eines Friedhof-Eintrags: git branch <name> ${GRAVEYARD_NS}/<name>"
fi

# ------------------------------------------------------------------ 3. gc ----
# Kein `--prune=now`: unerreichbare Objekte jünger als zwei Wochen bleiben als
# Wiederherstellungs-Netz liegen. Objekte der Friedhof-Refs sind erreichbar und
# werden von gc grundsätzlich nicht angefasst.
if [ "$(loose_count)" -ge "$LOOSE_OBJECT_THRESHOLD" ] || [ "$(garbage_count)" -gt 0 ] || [ "$stale_lock" -eq 1 ]; then
  log "Starte Aufräum-/Packlauf (git gc) — kann einige Minuten dauern …"
  git gc --quiet
  log "git gc abgeschlossen."
else
  log "Unter der Schwelle von ${LOOSE_OBJECT_THRESHOLD} losen Objekten — kein gc nötig."
fi

# ------------------------------------------------------- 4. Integritätscheck --
if git fsck --no-progress --connectivity-only >/dev/null 2>&1; then
  log "Integritätsprüfung (git fsck --connectivity-only): sauber."
else
  log "WARNUNG: git fsck meldet Auffälligkeiten — bitte manuell prüfen (git fsck)."
fi

# ---------------------------------------------------------------- Nachher -----
log "NACHHER:"
report
log "Vorher/Nachher — Größe: ${before_size} → $(dir_size) | lose Objekte: ${before_loose} → $(loose_count) | Refs: ${before_refs} → $(ref_count) | lokale Branches: ${before_heads} → $(head_count)"
