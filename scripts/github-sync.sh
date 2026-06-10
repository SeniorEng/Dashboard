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

# Remote main-SHA via GitHub-API (read-only). Erstes 40-stelliges Hex == object.sha.
remote_sha() {
  local token="${GITHUB_PERSONAL_ACCESS_TOKEN:-${GITHUB_WORKFLOW_PAT:-}}"
  if [ -z "$token" ]; then
    log "Weder GITHUB_PERSONAL_ACCESS_TOKEN noch GITHUB_WORKFLOW_PAT gesetzt — kann Remote-SHA nicht lesen."
    return 1
  fi
  curl -fsS \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "${API_REF}" \
    | grep -oE '[0-9a-f]{40}' | head -1
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

  # 1) Standard-Connector-Token (Code/Doku-Pushes).
  if [ -n "$connector" ]; then
    if out="$(do_push "$connector")"; then
      log "Push mit Connector-Token erfolgreich."
      verify_pushed "$lsha"
      return 0
    fi
    log "Connector-Token-Push fehlgeschlagen:"
    printf '%s\n' "$out" >&2
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
      verify_pushed "$lsha"
      return 0
    fi
    log "PAT-Push fehlgeschlagen:"
    printf '%s\n' "$out" >&2
  else
    log "Kein GITHUB_WORKFLOW_PAT gesetzt — Workflow-Dateien können nicht gepusht werden (GH013)."
  fi

  log "FEHLER: Push fehlgeschlagen (siehe Ausgabe oben)."
  return 1
}

# Nach dem Push verifizieren, dass die Remote-SHA der gepushten entspricht.
verify_pushed() {
  local expected="$1" got
  got="$(remote_sha || true)"
  if [ -n "$got" ] && [ "$got" = "$expected" ]; then
    log "Verifiziert: GitHub main steht jetzt auf ${got}."
  else
    log "WARNUNG: Remote-SHA nach Push (${got:-unbekannt}) != erwartete (${expected})."
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
