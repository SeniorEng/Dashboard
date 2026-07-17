#!/usr/bin/env bash
#
# github-sync.sh — Automatischer GitHub-Sync (Task #1152)
#
# Hält den Branch `main` auf `SeniorEng/Dashboard` auf dem Stand des
# Replit-Projekts, damit CI nie alten Code testet. Ersetzt den manuellen,
# leicht zu vergessenden `git push` (siehe docs/ci-pipeline.md → GitHub-Sync).
#
# Subcommands:
#   push   (default)  Pusht `main` nach GitHub, falls der lokale Stand vom
#                     Remote abweicht. No-op, wenn bereits in sync.
#   check             Drift-Signal: vergleicht lokale vs. remote main-SHA und
#                     prüft den OpenAPI-Spec-Drift. Exit != 0 bei Drift.
#                     Verändert nichts (read-only).
#
# Authentifizierung (in dieser Reihenfolge probiert):
#   1. GITHUB_PERSONAL_ACCESS_TOKEN  — Standard-Connector-Token (Code/Doku).
#   2. GITHUB_WORKFLOW_PAT           — Classic-PAT mit `repo`+`workflow`-Scope.
#                                      Nötig, sobald `.github/workflows/*`
#                                      mitgepusht wird (Connector-Token hat
#                                      kein `workflow`-Scope → GH013).
# Der Push fällt bei einem Workflow-Scope-Fehler automatisch auf den PAT
# zurück; in einem Scheduled Deployment (wo der Connector-Token evtl. fehlt)
# greift direkt der PAT.
#
# Cadence: als Replit Scheduled Deployment einrichten (Run-Command
#   `bash scripts/github-sync.sh push`, z.B. stündlich). Details:
#   docs/ci-pipeline.md → "Automatisierter Sync".

set -euo pipefail

REPO="SeniorEng/Dashboard"
BRANCH="main"
API_REF="https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}"

log() { printf '[github-sync] %s\n' "$*" >&2; }

# Lokale main-SHA — bevorzugt git, Fallback auf das Ref-File (kein git nötig).
local_sha() {
  git rev-parse HEAD 2>/dev/null || cat ".git/refs/heads/${BRANCH}" 2>/dev/null || true
}

# Remote-SHA-Lesung mit EINEM konkreten Token. Exit-Codes:
#   0  Erfolg (gibt die 40-stellige Remote-SHA auf stdout aus)
#   2  kein Token übergeben
#   3  Authentifizierung fehlgeschlagen (401/403 — Token abgelaufen/ungültig)
#   1  sonstiger Fehler (Netzwerk/Transport oder unerwarteter HTTP-Status)
remote_sha_with_token() {
  local token="$1"
  [ -z "$token" ] && return 2
  local response http_code body
  if ! response="$(curl -sS -w $'\n%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.github+json" \
      "${API_REF}" 2>/dev/null)"; then
    return 1
  fi
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
    200)
      printf '%s\n' "$body" | grep -oE '[0-9a-f]{40}' | head -1
      return 0
      ;;
    401|403) return 3 ;;
    *)       return 1 ;;
  esac
}

# Remote main-SHA via GitHub-API (read-only). Probiert die verfügbaren Token und
# nutzt denjenigen, der tatsächlich 200 liefert — so maskiert ein abgelaufener
# Connector-Token kein erfolgreiches Lesen über einen anderen Token mehr.
# Optionaler $1: bevorzugter Token (z.B. der, der den Push authentifiziert hat),
# wird zuerst probiert.
remote_sha() {
  local preferred="${1:-}"
  local token rc auth_failed=0 sha
  for token in "$preferred" "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" "${GITHUB_WORKFLOW_PAT:-}"; do
    [ -z "$token" ] && continue
    if sha="$(remote_sha_with_token "$token")"; then
      printf '%s\n' "$sha"
      return 0
    else
      rc=$?
      [ "$rc" = "3" ] && auth_failed=1
    fi
  done
  if [ "$auth_failed" = "1" ]; then
    log "Remote-SHA-Lesung scheiterte an Authentifizierung (401/403) — Token abgelaufen/ungültig? GITHUB_WORKFLOW_PAT erneuern."
  else
    log "Remote-SHA konnte mit keinem verfügbaren Token gelesen werden (kein Token gesetzt oder Netzwerkfehler)."
  fi
  return 1
}

# OpenAPI-Spec-Drift (committete Spec vs. frisch aus den Zod-Schemas generiert).
spec_drift_check() {
  if npm run --silent gen:openapi -- --check; then
    return 0
  fi
  return 1
}

cmd_check() {
  local lsha rsha rc=0
  lsha="$(local_sha)"
  rsha="$(remote_sha || true)"

  log "Lokale  main-SHA: ${lsha:-unbekannt}"
  log "Remote  main-SHA: ${rsha:-unbekannt}"

  if [ -z "$rsha" ]; then
    log "DRIFT-SIGNAL: Remote-SHA konnte nicht ermittelt werden."
    rc=1
  elif [ "$lsha" = "$rsha" ]; then
    log "OK: GitHub ist auf dem lokalen Stand (kein SHA-Drift)."
  else
    log "DRIFT-SIGNAL: GitHub main ist NICHT auf dem lokalen Stand — Sync nötig (push)."
    rc=1
  fi

  if spec_drift_check; then
    log "OK: OpenAPI-Spec ist aktuell."
  else
    log "DRIFT-SIGNAL: OpenAPI-Spec driftet — 'npm run gen:openapi' laufen lassen und committen."
    rc=1
  fi

  return "$rc"
}

# Push über einen gegebenen Token; gibt die git-Ausgabe (inkl. Fehler) zurück.
do_push() {
  local token="$1"
  git push "https://x-access-token:${token}@github.com/${REPO}.git" "HEAD:${BRANCH}" 2>&1
}

# Erkennt an der git-Ausgabe, ob ein Push-Fehler ein Auth-/Token-Problem ist
# (abgelaufener/ungültiger Token) und nicht ein bloßer Netzwerkfehler.
looks_like_auth_failure() {
  printf '%s' "$1" | grep -qiE 'Authentication failed|Invalid username or password|Bad credentials|could not read Username|remote: (Invalid|Permission)|HTTP (401|403)|403 Forbidden|401 Unauthorized'
}

# Erkennt an der git-Ausgabe, ob der Push wegen DIVERGIERTER Historie abgelehnt
# wurde (non-fast-forward). Das ist KEIN Token-/Netzwerkfehler, sondern verlangt
# einen einmaligen, kontrollierten Force-Push-Reconcile über das Runbook
# (docs/ci-pipeline.md → Force-Push/Branch-Protection). Ohne diese Erkennung
# maskierte der generische "kein Token akzeptierte den Push"-Zweig die wahre
# Ursache und der Sync blieb still stehen (Backlog wuchs unbemerkt).
looks_like_non_fast_forward() {
  printf '%s' "$1" | grep -qiE 'non-fast-forward|failed to push some refs|Updates were rejected|fetch first|tip of your current branch is behind'
}

cmd_push() {
  local lsha rsha
  lsha="$(local_sha)"
  rsha="$(remote_sha || true)"

  if [ -n "$rsha" ] && [ "$lsha" = "$rsha" ]; then
    log "Bereits in sync (${lsha}) — nichts zu pushen."
    return 0
  fi

  log "Drift erkannt: lokal=${lsha:-?} remote=${rsha:-unbekannt}. Pushe ${BRANCH} → ${REPO}…"

  local connector="${GITHUB_PERSONAL_ACCESS_TOKEN:-}"
  local pat="${GITHUB_WORKFLOW_PAT:-}"
  local out=""

  local auth_seen=0
  local nonff_seen=0

  # 1) Standard-Connector-Token (Code/Doku-Pushes).
  if [ -n "$connector" ]; then
    if out="$(do_push "$connector")"; then
      log "Push mit Connector-Token erfolgreich."
      verify_pushed "$lsha" "$connector"
      return 0
    fi
    log "Connector-Token-Push fehlgeschlagen:"
    printf '%s\n' "$out" >&2
    looks_like_auth_failure "$out" && auth_seen=1
    looks_like_non_fast_forward "$out" && nonff_seen=1
    if printf '%s' "$out" | grep -qiE 'GH013|workflow|refusing to allow'; then
      log "Workflow-Scope-Problem (.github/workflows/*) erkannt — versuche GITHUB_WORKFLOW_PAT."
    fi
  else
    log "Kein GITHUB_PERSONAL_ACCESS_TOKEN — versuche direkt GITHUB_WORKFLOW_PAT."
  fi

  # 2) PAT-Fallback (repo+workflow-Scope, deckt auch Workflow-Dateien ab).
  if [ -n "$pat" ]; then
    if out="$(do_push "$pat")"; then
      log "Push mit GITHUB_WORKFLOW_PAT erfolgreich."
      verify_pushed "$lsha" "$pat"
      return 0
    fi
    log "PAT-Push fehlgeschlagen:"
    printf '%s\n' "$out" >&2
    looks_like_auth_failure "$out" && auth_seen=1
    looks_like_non_fast_forward "$out" && nonff_seen=1
  else
    log "Kein GITHUB_WORKFLOW_PAT gesetzt — Workflow-Dateien können nicht gepusht werden (GH013)."
  fi

  log "FEHLER: GitHub-Sync-Push fehlgeschlagen — GitHub main bleibt zurück (Backlog wächst)."
  if [ "$nonff_seen" = "1" ]; then
    log "→ Ursache: DIVERGIERTE Historie (non-fast-forward) — GitHub main hat Commits, die Replit nicht hat, oder die Historien sind auseinandergelaufen."
    log "→ Ein normaler Sync-Push kann das NICHT reparieren. Einmaliger kontrollierter Force-Push-Reconcile nötig:"
    log "→   docs/ci-pipeline.md → 'Force-Push / Branch-Protection' (allow_force_pushes temporär an, --force-with-lease, sofort wieder aus)."
    log "→ Bis dahin testet die GitHub-CI veralteten Code — dieser Fehlschlag ist der beabsichtigte Alarm, kein stiller Stillstand."
  elif [ "$auth_seen" = "1" ]; then
    log "→ Ursache: Token ungültig/abgelaufen. GITHUB_WORKFLOW_PAT (Scope repo+workflow) in den Deployment-Secrets erneuern."
  else
    log "→ Push wurde von keinem Token akzeptiert (siehe Ausgabe oben). Token/Secrets und Netzwerk prüfen."
  fi
  return 1
}

# Nach dem Push verifizieren, dass die Remote-SHA der gepushten entspricht.
# $2 (optional): der Token, der den Push authentifiziert hat — wird zum
# Gegenlesen bevorzugt, damit ein abgelaufener Connector-Token keine falsche
# WARNUNG nach einem in Wahrheit erfolgreichen Push erzeugt.
verify_pushed() {
  local expected="$1" worked_token="${2:-}" got
  got="$(remote_sha "$worked_token" || true)"
  if [ -n "$got" ] && [ "$got" = "$expected" ]; then
    log "Verifiziert: GitHub main steht jetzt auf ${got}."
    return 0
  fi
  if [ -z "$got" ]; then
    log "HINWEIS: Push war erfolgreich, aber die Remote-SHA konnte nicht gegengelesen werden (Leserecht/Netzwerk). Der Push gilt trotzdem als erfolgreich."
  else
    log "WARNUNG: Remote-SHA nach Push (${got}) != erwartete (${expected})."
  fi
}

main() {
  local cmd="${1:-push}"
  case "$cmd" in
    push)  cmd_push ;;
    check) cmd_check ;;
    *)
      log "Unbekanntes Subcommand: ${cmd}. Erlaubt: push | check."
      return 2
      ;;
  esac
}

main "$@"
