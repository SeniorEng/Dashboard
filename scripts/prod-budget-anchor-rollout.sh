#!/usr/bin/env bash
#
# prod-budget-anchor-rollout.sh — Sicherer Production-Rollout des Budget-Anker-
# Backfills (Task #1209, kapselt server/scripts/backfill-budget-anchor.ts).
#
# Hintergrund:
#   Der Budget-Anker-Backfill (Task #1203, server/scripts/backfill-budget-anchor.ts)
#   ist auf DEV bereits gelaufen. Er muss noch gegen die LIVE-Production-DB
#   ausgeführt werden. Dieser Workspace hat aber nur Read-Only-Production-Zugriff
#   — der Backfill kann von hier NICHT scharf gefahren werden. Stattdessen wird
#   dieses Skript als Replit Scheduled/One-Off Deployment ausgeführt, wo
#   `DATABASE_URL` auf Production zeigt (separates Deployment-Objekt, NICHT das
#   Web-App-`[deployment]` in `.replit`; analog scripts/github-sync.sh).
#
# Was dieses Skript NICHT tut:
#   Es REIMPLEMENTIERT die Backfill-Logik NICHT. Die Klassifikation (SAFE/REVIEW),
#   die §45a/§39-Messung VOR/NACH, der DB-Host-/`--confirm-prod`-Guard und das
#   GoBD-Audit-Logging leben vollständig im bestehenden tsx-Skript. Dieser Wrapper
#   orchestriert nur: Pre-Rollout-Backup → Dry-Run → (gewählte Stufe) Apply →
#   Idempotenz-Re-Check, und hält die zwei Stufen menschlich-gegated getrennt.
#
# Subcommands:
#   dry-run          Backup + Dry-Run (read-only Klassifikation). Schreibt NICHTS.
#   safe   (default) Backup + Dry-Run + SAFE-Apply (--apply --confirm-prod)
#                    + Idempotenz-Re-Check. Schreibt NUR die SAFE-Stufe
#                    (Origin-Stempel + §45b-Bodung; §45a/§39 unverändert).
#   review           Backup + Dry-Run + REVIEW-Apply
#                    (--apply --include-window-shifts --confirm-prod)
#                    + Idempotenz-Re-Check. Verschiebt §45a/§39-Fenster (Kunde
#                    #164). NUR mit explizitem Opt-in `--i-reviewed-164`
#                    (oder Env CONFIRM_WINDOW_SHIFTS=1) — sonst harter Abbruch.
#
# Sicherheit (mehrschichtig):
#   1. Das Backup (scripts/backup-prod-db.sh) MUSS erfolgreich sein, bevor
#      irgendein Apply läuft. Schlägt es fehl, bricht der Lauf ab (set -e).
#   2. Der DB-Host-/`--confirm-prod`-Guard im tsx-Skript bleibt voll intakt —
#      dieser Wrapper gibt `--confirm-prod` NUR im Apply-Pfad weiter, der Dry-Run
#      bleibt schreibfrei.
#   3. Die REVIEW-Stufe (Fenster-Shift #164) verlangt einen zweiten, bewussten
#      Opt-in-Schalter. Der Default-Job (`safe`) fasst sie NIE an.
#
# Aufruf-Beispiele (im Production-Deployment-Kontext, DATABASE_URL = Prod):
#   bash scripts/prod-budget-anchor-rollout.sh dry-run
#   bash scripts/prod-budget-anchor-rollout.sh safe
#   bash scripts/prod-budget-anchor-rollout.sh review --i-reviewed-164
#
# Vollständiges Operator-Runbook: docs/budget-anchor-rollout-runbook.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKFILL_SCRIPT="server/scripts/backfill-budget-anchor.ts"
BACKUP_SCRIPT="scripts/backup-prod-db.sh"
BACKUP_LABEL="-pre-budget-anchor-rollout"

log()  { printf '[anchor-rollout] %s\n' "$*" >&2; }
fail() { log "FEHLER: $*"; exit 1; }

# Resolved DB-Host prominent loggen (Spiegel des tsx-Skript-Guards).
db_host() {
  node -e '
    const u = process.env.DATABASE_URL || "";
    try { console.log(new URL(u).hostname.toLowerCase()); }
    catch { const m = u.match(/@([^/:?]+)/); console.log((m ? m[1] : "").toLowerCase()); }
  ' 2>/dev/null || true
}

looks_like_prod() {
  local host="$1"
  [ "${NODE_ENV:-}" = "production" ] && return 0
  printf '%s' "$host" | grep -qiE '(^|[.-])prod([.-]|$)|production' && return 0
  return 1
}

# ---- Pre-Rollout-Backup (Pflicht vor jedem Apply) --------------------------
run_backup() {
  [ -f "$BACKUP_SCRIPT" ] || fail "Backup-Skript $BACKUP_SCRIPT nicht gefunden."

  # backup-prod-db.sh erwartet PROD_DATABASE_URL. Im Production-Deployment zeigt
  # DATABASE_URL auf Prod — daraus die Backup-URL ableiten, falls nicht gesetzt.
  if [ -z "${PROD_DATABASE_URL:-}" ]; then
    [ -n "${DATABASE_URL:-}" ] || fail "Weder PROD_DATABASE_URL noch DATABASE_URL gesetzt — kein Backup-Ziel."
    export PROD_DATABASE_URL="$DATABASE_URL"
    log "PROD_DATABASE_URL aus DATABASE_URL abgeleitet (Production-Deployment-Kontext)."
  fi

  log "Starte Pre-Rollout-Backup (scripts/backup-prod-db.sh, Label ${BACKUP_LABEL}) …"
  local out
  if ! out="$(BACKUP_LABEL="$BACKUP_LABEL" bash "$BACKUP_SCRIPT" 2>&1)"; then
    printf '%s\n' "$out" >&2
    fail "Backup fehlgeschlagen — KEIN Apply. Rollout abgebrochen."
  fi
  printf '%s\n' "$out" >&2

  # Verifizieren, dass ein nicht-leerer Custom-Dump entstanden ist.
  local dump
  dump="$(printf '%s\n' "$out" | grep -oE 'tmp/db-backups/prod-[^ ]+\.dump' | head -1 || true)"
  if [ -z "$dump" ] || [ ! -s "$dump" ]; then
    fail "Backup-Dump nicht gefunden oder leer — KEIN Apply. Rollout abgebrochen."
  fi
  log "Backup verifiziert: $dump ($(du -h "$dump" | cut -f1))."
  log "→ SHA256 + Pfad in docs/deployment-log.md eintragen (Runbook §5)."
}

# ---- Backfill-Aufrufe ------------------------------------------------------
backfill_dry_run() {
  log "Dry-Run: $BACKFILL_SCRIPT (read-only, rollt jede Transaktion zurück) …"
  npx tsx "$BACKFILL_SCRIPT"
}

backfill_apply_safe() {
  log "SAFE-Apply: $BACKFILL_SCRIPT --apply --confirm-prod …"
  npx tsx "$BACKFILL_SCRIPT" --apply --confirm-prod
}

backfill_apply_review() {
  log "REVIEW-Apply: $BACKFILL_SCRIPT --apply --include-window-shifts --confirm-prod …"
  npx tsx "$BACKFILL_SCRIPT" --apply --include-window-shifts --confirm-prod
}

# Idempotenz-Re-Check: erneuter Dry-Run, prüft die verbleibenden betroffenen
# Kunden je Stufe. Nach SAFE darf die SAFE-Zahl 0 sein (REVIEW #164 bleibt offen);
# nach REVIEW müssen BEIDE Zahlen 0 sein.
idempotency_check() {
  local expect_review_zero="$1" out safe review
  log "Idempotenz-Re-Check (erneuter Dry-Run) …"
  out="$(npx tsx "$BACKFILL_SCRIPT" 2>&1)"
  printf '%s\n' "$out" >&2

  # Die SAFE-Tier-Zeile enthält "§45a/§39" — Ziffern VOR der Zahl. Deshalb die
  # LETZTE Zahl der jeweiligen Summenzeile nehmen (= der Stufen-Count).
  safe="$(printf '%s\n' "$out"   | grep '^SAFE-Tier'   | grep -oE '[0-9]+' | tail -1)"
  review="$(printf '%s\n' "$out" | grep '^REVIEW-Tier' | grep -oE '[0-9]+' | tail -1)"
  safe="${safe:-?}"; review="${review:-?}"
  log "Re-Check Ergebnis: verbleibend SAFE=${safe} · REVIEW=${review}."

  if [ "$safe" != "0" ]; then
    fail "Idempotenz verletzt: nach Apply sind noch ${safe} SAFE-Kunde(n) betroffen."
  fi
  if [ "$expect_review_zero" = "yes" ] && [ "$review" != "0" ]; then
    fail "Idempotenz verletzt: nach REVIEW-Apply sind noch ${review} REVIEW-Kunde(n) betroffen."
  fi
  if [ "$expect_review_zero" = "no" ] && [ "$review" != "0" ]; then
    log "Hinweis: ${review} REVIEW-Kunde(n) bleiben absichtlich offen (Fenster-Shift, separater Opt-in)."
  fi
  log "Idempotenz-Re-Check bestanden."
}

confirm_review_optin() {
  for a in "$@"; do
    [ "$a" = "--i-reviewed-164" ] && return 0
  done
  [ "${CONFIRM_WINDOW_SHIFTS:-}" = "1" ] && return 0
  return 1
}

# ---- Main ------------------------------------------------------------------
main() {
  local cmd="${1:-safe}"; shift || true
  local host; host="$(db_host)"

  log "=== Budget-Anker-Production-Rollout (Task #1209) ==="
  log "Subcommand: ${cmd}"
  log "DB-Host: ${host:-(unbekannt)} · $(looks_like_prod "$host" && echo PROD-VERDACHT || echo nicht-prod)"
  [ -f "$BACKFILL_SCRIPT" ] || fail "Backfill-Skript $BACKFILL_SCRIPT nicht gefunden."

  case "$cmd" in
    dry-run)
      run_backup
      backfill_dry_run
      log "Dry-Run abgeschlossen. Erwartung: ~6 Origin-Stempel + ~61 §45b (SAFE), Kunde #164 §39-Fenster (REVIEW)."
      ;;
    safe)
      run_backup
      log "--- Phase 1: Dry-Run (Klassifikation surfaced) ---"
      backfill_dry_run
      log "--- Phase 2: SAFE-Apply ---"
      backfill_apply_safe
      idempotency_check "no"
      log "SAFE-Rollout abgeschlossen. REVIEW-Stufe (#164) bleibt offen — separater Lauf: 'review --i-reviewed-164'."
      ;;
    review)
      if ! confirm_review_optin "$@"; then
        fail "REVIEW-Stufe (§45a/§39-Fenster-Shift, Kunde #164) verlangt explizites Opt-in: '--i-reviewed-164' oder CONFIRM_WINDOW_SHIFTS=1. Abbruch."
      fi
      log "REVIEW-Opt-in bestätigt — Fenster-Shift wird angewandt."
      run_backup
      log "--- Phase 1: Dry-Run (Klassifikation surfaced) ---"
      backfill_dry_run
      log "--- Phase 2: REVIEW-Apply (inkl. SAFE-Rest + Fenster-Shift) ---"
      backfill_apply_review
      idempotency_check "yes"
      log "REVIEW-Rollout abgeschlossen. Beide Stufen idempotent (0 verbleibend)."
      ;;
    *)
      fail "Unbekanntes Subcommand: ${cmd}. Erlaubt: dry-run | safe | review"
      ;;
  esac

  log "Fertig (${cmd})."
}

main "$@"
