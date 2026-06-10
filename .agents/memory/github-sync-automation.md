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
