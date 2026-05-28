---
name: CI workflow file missing from GitHub repo
description: Why GitHub Actions CI never actually runs on SeniorEng/Dashboard despite replit.md documenting it
---

# CI workflow is committed locally but absent from the GitHub repo

`.github/workflows/ci.yml` is tracked in the local/platform git, but the GitHub
repo `SeniorEng/Dashboard` has **zero** workflows registered and no `.github/`
directory on its `main` branch. The Replit "Publish your App" snapshot did not
include the workflow file.

**Why:** The connected GitHub OAuth token only carries scopes
`read:org, read:project, read:user, repo, user:email` — it has **no `workflow`
scope**. Any attempt to create/update a tree or ref that adds a path under
`.github/workflows/` via the GitHub API is rejected (tree create returns 404),
so neither the publish flow nor the API can push the workflow file.

**Consequences:**
- The required status checks configured in branch protection
  (`static-analysis`, `tests`, `e2e-smoke`, strict) can never be reported,
  because no workflow produces them. With strict protection this means PRs
  cannot satisfy the checks at all until the workflow file is pushed.
- Repo Actions secrets (e.g. `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`) are set
  correctly but have no consumer until `ci.yml` lands on the repo.

**How to apply / fix:** To actually enable the gate, the GitHub connection must
be re-authorized **with the `workflow` scope** (or `ci.yml` pushed via a PAT
that has it). After that, verification (a PR triggering the checks, a
deliberately failing test blocking merge) becomes possible. Don't assume CI is
live on the GitHub repo just because replit.md documents it — check
`GET /repos/.../actions/workflows` (total_count) first.
