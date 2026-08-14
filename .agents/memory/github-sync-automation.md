---
name: GitHub-Sync automation (Replit→GitHub main)
description: Why the CI-sync push is a Replit-side script + Scheduled Deployment, not a GitHub Actions workflow, and how the token fallback works
---

# Keeping GitHub `main` in sync with the Replit project

The push that keeps `SeniorEng/Dashboard` `main` current MUST originate on the
Replit side — only the Replit env has the working copy and the GitHub tokens. A
GitHub Actions workflow CANNOT do it: Actions runs on GitHub and cannot "pull"
the Replit project state. So the automation is `scripts/github-sync.sh`
(`check` = read-only drift signal, `push` = idempotent sync) wired to a Replit
**Scheduled Deployment** (separate from the web-app deployment), NOT a new
`.github/workflows/*` file.

**Why:** besides the "can't pull Replit" limitation, a *new* workflow file would
never reach GitHub through the normal connector sync (the connector OAuth token
has no `workflow` scope → GH013), so a GitHub-Actions-based sync is self-defeating.

**How to apply:**
- Drift signal: `bash scripts/github-sync.sh check` — compares local `main` SHA
  (`git rev-parse HEAD`, fallback `.git/refs/heads/main`) vs the GitHub-API ref
  SHA, plus `gen:openapi -- --check`. Exit 0 = in sync + spec clean, 1 = drift.
- Token fallback in `push`: tries `GITHUB_PERSONAL_ACCESS_TOKEN` (connector,
  code/doc), then falls back to `GITHUB_WORKFLOW_PAT` on a GH013/workflow-scope
  failure OR when the connector token is absent (e.g. inside a deployment). The
  PAT (repo+workflow) is the universal fallback that also carries workflow files.
- Both `GITHUB_PERSONAL_ACCESS_TOKEN` and `GITHUB_WORKFLOW_PAT` exist as env vars
  in the dev environment; in a Scheduled Deployment ensure `GITHUB_WORKFLOW_PAT`
  is available.
- A task agent can't publish, so the Scheduled Deployment is a one-time user
  setup (Publishing → Scheduled, run `bash scripts/github-sync.sh push`); after
  that the sync runs with no manual steps. Full runbook in
  `docs/ci-pipeline.md` → "Automatisierter Sync".

## GITHUB_WORKFLOW_PAT expires; false "WARNUNG" after a good push

`GITHUB_WORKFLOW_PAT` (and `GITHUB_PERSONAL_ACCESS_TOKEN`) are manually-minted
classic PATs that **expire** — when they do, the Scheduled-Deployment sync fails
silently and the backlog grows (40-commit catch-up was a stalled sync). The fix
is purely a fresh classic PAT with `repo`+`workflow` scopes; no code change.
Diagnose before chasing the script: `curl -H "Authorization: Bearer $TOKEN"
https://api.github.com/user` → 401 = dead token, `x-oauth-scopes` shows scopes.
The OAuth connector token (`listConnections('github')[0].settings.access_token`)
is always fresh but has `repo` only (no `workflow`), so it hits GH013 on any
commit touching `.github/workflows/*` — it cannot replace the PAT.

**Script gotcha (RESOLVED):** the post-push read must use the token that
authenticated the push, not always the connector token first — otherwise an
expired connector token returns 401 on the read and prints a false
`WARNUNG: Remote-SHA ... unbekannt` after a fully successful push. `remote_sha`
now takes an optional preferred-token arg, `verify_pushed` passes the token that
worked, and the reader tries both tokens and accepts only HTTP 200. If no token
can read back, it logs a neutral `HINWEIS` (push still counts), never `WARNUNG`.
A failed push (dead/expired PAT) now exits non-zero with an actionable
"refresh GITHUB_WORKFLOW_PAT" message so the Scheduled Deployment marks the run
failed instead of the backlog growing silently. Any future change here must keep
the read-token preference tied to the push-token, not hardcode connector-first.

**Probe before push:** the script now spends ONE read-only API request per token
before pushing with it; `401/403` ⇒ the token is declared dead, skipped (no push
attempt) and remembered as dead for the rest of the run, so the remote-SHA read
doesn't retry it either. An *inconclusive* probe (network/transport, not 401/403)
must still fall through to a real push attempt — never let the probe lock out a
working token. `doctor` (npm `sync:doctor`) exposes the same probe read-only.
See also `git-token-broker-outage.md` for the pane-is-dead failure mode.

**Agent env note:** newly-added secrets ARE live in freshly-spawned bash tool
processes (proven with a `setEnvVars` probe round-trip) — a 401 on a just-added
token is the token being bad, not a stale env.

## One-time divergence reconcile (force-push through branch protection)

Steady-state pushes are fast-forwards. If GitHub `main` has *diverged* (GitHub-only
commits not in local history), a plain push is rejected `non-fast-forward`. To keep
the steady-state sync working you must set GitHub `main` to EXACTLY the local SHA — a
merge commit is wrong (the next local commit descends from the local SHA, not from a
GitHub-side merge node, so the following push would also be non-ff). That requires a
**force-push**.

`scripts/github-sync.sh` now classifies this case explicitly: `looks_like_non_fast_forward`
matches the git rejection (`non-fast-forward`/`failed to push some refs`/`Updates were
rejected`/`fetch first`/`tip … is behind`) and the push-failure branch emits a divergence
alarm pointing at the reconcile runbook, instead of the misleading generic "no token
accepted the push" message. Keep this distinct from `looks_like_auth_failure` — a divergence
is NOT a token problem and must not be "fixed" by rotating the PAT.

Branch protection blocks force-push for EVERYONE incl. admins: `allow_force_pushes=false`
rejects with `GH006` even with an admin PAT and `enforce_admins=false` (admin override
covers required-checks/reviews, NOT force-push). Procedure: GET the full protection
object, `PUT …/branches/main/protection` with `allow_force_pushes:true` and every other
field byte-identical (esp. required_status_checks contexts + their `app_id`s, e.g.
`erechnung-validation` app_id 15368), `git push --force-with-lease`, then immediately PUT
again with `allow_force_pushes:false`. Verify remote SHA == local SHA and protection
restored.

**Caveat — green local suite ≠ green CI.** The DB/server CI gates (`tests`, `e2e-smoke`,
`template-cache-verify`) and `static-analysis` (`npm audit --audit-level=high`) can be red
even when the local suite passes: `npm audit` tracks the external advisory DB (a moving
target), and the CI seed path has its own bugs independent of the test code (FK seed
order, missing service-catalog rows). Pushing a "green local main" does NOT imply CI goes
green — check the actual run, don't assume.
