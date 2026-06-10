---
name: GitHub Actions CI — on the repo now, but DB-gates can't go green yet
description: State of CI on SeniorEng/Dashboard after the workflow file was finally pushed, and the two remaining blockers that keep the DB-backed gates red
---

# CI workflow IS now on the GitHub repo (was previously missing)

`.github/workflows/ci.yml` and `scripts/ci-seed-superadmin.ts` are now present on
`SeniorEng/Dashboard` `main`, the workflow is **registered + active**
(`GET /actions/workflows` total_count = 1), and it runs on every push/PR.
Branch protection correctly gates merges on the checks (a PR with a red required
check shows `mergeable_state: blocked`).

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

## Two remaining blockers keep `tests` / `e2e-smoke` / `static-analysis` red

These are NOT the "file missing" problem — they only became visible once CI
actually ran for the first time.

1. **Neon serverless driver vs CI's plain Postgres.** `server/lib/db.ts` uses
   `@neondatabase/serverless` with `useSecureWebSocket = true` (WebSocket/TLS).
   CI provisions a plain `postgres:16` service container and sets
   `DATABASE_URL=postgres://...@localhost:5432/...`. The driver tries a secure
   WebSocket and gets `ECONNREFUSED`, so the **Seed test superadmin** step (and
   any server/test step using the app DB layer) fails before any real test runs.
   Note `drizzle-kit push` works fine (it uses a direct pg connection, not the
   neon driver). Fix needs a CI WebSocket proxy (e.g. local-neon-http-proxy) +
   an env-gated branch in `db.ts` to disable secure WS / set `wsProxy` when
   targeting the proxy — production path (real neon host) must stay untouched.

2. **Repo-staleness — RESOLVED + decision recorded.** GitHub `main` used to track
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

**Consequence:** because branch protection requires `static-analysis`, `tests`,
`e2e-smoke` (strict), and those are red, PRs are still blocked from merging until
the two blockers above are resolved. This was also true before (checks absent),
so it's not a regression — but "checks are green and merges flow" needs both fixes.
