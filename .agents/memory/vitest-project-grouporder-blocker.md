---
name: Full vitest run blocked by groupOrder
description: Why `vitest run` (full, all projects) aborts before any test and how to verify changes anyway in this repo.
---

A full `vitest run` (all projects) aborts BEFORE executing any test with:
`Error: Projects "integration" and "unit" have different 'maxWorkers' but
same 'sequence.groupOrder'. Provide unique 'sequence.groupOrder' for them.`

**Why:** `vitest.config.ts` defines two projects — `unit` (fileParallelism, no
explicit maxWorkers) and `integration` (maxWorkers pinned to
`EPHEMERAL_DB_WORKERS`). Vitest 4's pool rework (the repo's vitest-4 migration)
now requires projects with differing maxWorkers to declare a unique
`sequence.groupOrder`. The repo doesn't, so the orchestrated `test` workflow
(`scripts/with-ephemeral-db.ts`, EPHEMERAL_DB_WORKERS=2) fails at the config
stage. It is NOT a test/logic failure and is unrelated to test/startup code.

**How to apply:** To verify test changes, run TARGETED raw vitest against a
single file or single project (e.g. `npx vitest run tests/<file>.test.ts`) —
the groupOrder check only compares projects that both have matching specs, so a
single-file run (or `--project integration`) sidesteps it. Until the config is
fixed (add unique `sequence: { groupOrder }` per project), do not rely on the
full `test` workflow / full `vitest run` to validate.
