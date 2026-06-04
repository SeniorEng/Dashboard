---
name: Full vitest run + project groupOrder (vitest 4)
description: vitest 4 aborts a multi-project run when projects share sequence.groupOrder but differ in maxWorkers — and how the repo resolves it.
---

A full `vitest run` over multiple projects can abort BEFORE any test with:
`Error: Projects "integration" and "unit" have different 'maxWorkers' but
same 'sequence.groupOrder'. Provide unique 'sequence.groupOrder' for them.`

**Why:** vitest 4's `groupSpecs` (the spec-scheduler, runs ONCE over ALL specs
of ALL projects right AFTER globalSetup, BEFORE any test) groups specs by
`sequence.groupOrder`; if two projects land in the same order-group with
different resolved `maxWorkers`, it throws. The repo's `unit` project uses the
default parallel pool while `integration` pins `min/maxWorkers` to
`EPHEMERAL_DB_WORKERS`, so without distinct groupOrders they collide.

**Resolution (in `vitest.config.ts`):** the two projects declare distinct
`sequence.groupOrder` — `0` for `unit`, `1` for `integration`. They then run in
separate order-groups (unit first, then the DB/server-bound integration tests),
each with its own consistent pool config, so the throw never fires. The
integration project keeps `minWorkers === maxWorkers === EPHEMERAL_DB_WORKERS`,
preserving the 1:1 worker→DB mapping. The orchestrated `test` workflow
(`scripts/with-ephemeral-db.ts`, EPHEMERAL_DB_WORKERS=2) runs the full suite.

**How to verify:** the error fires only AFTER globalSetup succeeds (i.e. via the
orchestrator with a live app server), so a bare `npx vitest run` that times out
in globalSetup never reaches the grouping check and tells you nothing about it.
Trust the orchestrated `test` workflow: if integration specs are executing, the
single-pass `groupSpecs` already accepted ALL specs of BOTH projects.
