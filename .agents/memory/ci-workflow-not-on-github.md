---
name: GitHub Actions CI — live on the repo; tokens, and the re-publish durability trap
description: How CI got onto SeniorEng/Dashboard, the connector-vs-PAT token split for editing it, the two GitHub-runner-only blockers the erechnung-validation gate hit, and why GitHub-direct ci.yml edits regress unless mirrored into the isolated env.
---

# CI workflow is live on GitHub `SeniorEng/Dashboard`

`.github/workflows/ci.yml` runs on every push/PR. Branch protection on `main` is
`strict:true` and requires `static-analysis`, `tests`, `e2e-smoke`, and (since
2026-06-10) `erechnung-validation`. GitHub matches a required check by the job's
`name:`, which is kept identical to the job id.

**How it got there:** the connected GitHub OAuth token has no `workflow` scope, so
adding any path under `.github/workflows/` via the API 404s (and a `git push` that
touches `.github/workflows/*` is rejected with GH013). The fix was a
user-supplied classic **PAT with `repo` + `workflow` scopes** (stored as secret
`GITHUB_WORKFLOW_PAT`). The default connector token still cannot push workflow
files — if you need to re-push, request a PAT again.

**Two gotchas when (re-)pushing with the PAT:**
- A freshly-updated secret is NOT picked up by the already-running agent shell —
  `$GITHUB_WORKFLOW_PAT` in bash stays stale (old value) until you re-request it
  via `requestEnvVar`. Symptom: a brand-new valid token still 401s in bash while
  you can't explain why. Verify freshness by hashing the value (it should change).
- Embed the token directly in the push URL:
  `git push https://x-access-token:$PAT@github.com/SeniorEng/Dashboard.git main:main`.
  Do NOT use `https://git:@github.com/...` + GIT_ASKPASS — the empty password after
  the colon makes git skip askpass entirely and send an empty password →
  "Invalid username or token. Password authentication is not supported." even
  though the same token returns 200 on `/rate_limit`.

## Editing CI files: two different tokens

- **Connector token** (`listConnections('github')[0].settings.access_token`): has
  `repo` scope but NO `workflow` scope. Use it for branch protection and for
  reading/writing NON-workflow files (docs, `replit.md`) via the contents API,
  and for reading runs/jobs/logs.
- **`GITHUB_WORKFLOW_PAT`** (present in the SHELL env only, NOT in the code-exec
  sandbox): a classic PAT with `repo`+`workflow`. The ONLY way to PUT anything
  under `.github/workflows/`. Drive it from a `.mjs` script run via the bash tool
  (`process.env.GITHUB_WORKFLOW_PAT`); the bash tool rejects `cat`-heredocs and
  many inline `node -e`/`grep`/`rg` one-liners, so write a file then run it.

## Two GitHub-runner-only blockers the erechnung-validation job hit

The job had never actually run on GitHub before being made mandatory; both fixes
live in `ci.yml`:

1. **`npm ci` → EAI_AGAIN.** `package-lock.json` resolves a few packages via
   `http://package-firewall.replit.local/npm/...`, a host that only resolves
   inside Replit. Every `npm ci` step now runs a `sed` first that rewrites those
   URLs to `https://registry.npmjs.org/` (identical tarballs, integrity hashes
   still valid). This blocked ALL jobs, not just erechnung.
2. **veraPDF install → exit 127.** The installer zip extracts to a
   `verapdf-greenfield-<ver>/` subdir, but the dir-finding `find` used
   `-maxdepth 1` which also matched the parent `verapdf-installer` dir itself, so
   `$INSTALLER_DIR/verapdf-install` didn't exist. Fix: add `-mindepth 1`.
3. **Repo-staleness — RESOLVED + decision recorded.** GitHub `main` used to track
   the last "Published your App" snapshot, so post-publish work was missing and
   the **OpenAPI drift gate** (`gen:openapi -- --check`) went red purely from
   drift. Fixed by pushing the full local `main` (not hand-picking files). The
   recorded sync decision: **periodic `git push origin main:main` is the
   canonical CI-sync path, NOT publish** (publish lags day-to-day work and
   conflates deploy with CI-sync). Repeatable runbook lives in
   `docs/ci-pipeline.md` → "GitHub-Sync (Repo ↔ Replit-Projekt)". Quick local
   drift check before pushing: `npm run gen:openapi -- --check` (green = spec
   consistent, push will keep the CI gate green). Code/doc-only pushes use the
   normal connector token; only `.github/workflows/*` pushes still need the PAT.

## The re-publish durability trap (important)

I am in an ISOLATED task env; its files merge to the Replit "main app" (main env),
and the user separately PUBLISHES main env → GitHub. **A fix made ONLY on GitHub
via the API will be silently reverted the next time the user re-publishes**, because
the publish overwrites GitHub with the main-env copy.

**Why:** publish direction is main-env → GitHub, so any GitHub-only edit not present
in main-env is lost on the next publish.

**How to apply:** for any `ci.yml` (or other) fix you push directly to GitHub, apply
the SAME edit to the file in your isolated env so it propagates main env via the
task merge. Prefer minimal TARGETED edits (not a whole-file replace): the isolated
copy is usually behind main env (e.g. it lacked the WASM-XSD strict step), and a
targeted add lets the 3-way merge keep main-env-only content while layering your fix.

## What the gate actually validates (not a soft-skip)

CI sets `ERECHNUNG_REQUIRE_VALIDATORS=1`, so the job fails (not skips) unless both
real validators pass: Mustang/KoSIT reports EN-16931 `XML:valid` with 0 Schematron
errors, and veraPDF reports PDF/A-3b `isCompliant=true`. A separate Java-free
WASM-XSD strict step runs first so a strict-path regression goes red even if the
Mustang/veraPDF downloads hiccup.
