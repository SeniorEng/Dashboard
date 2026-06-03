---
name: Vitest 4 project config + parallel-harness-only flakes
description: Why the two vitest projects need distinct sequence.groupOrder, and which test files are flaky ONLY under the multi-worker ephemeral harness (green isolated + in CI).
---

# Vitest 4 multi-project config

The main `vitest.config.ts` defines two projects: `unit` (default parallel pool) and
`integration` (fork pool pinned to `EPHEMERAL_DB_WORKERS` via `min/maxWorkers`).

**Rule:** in Vitest 4, two projects that run in the SAME order-group but have DIFFERENT
`maxWorkers` abort the whole run before any test executes with
`Projects "integration" and "unit" have different 'maxWorkers' but same 'sequence.groupOrder'`.
The fix is to put them in distinct order-groups: `sequence.groupOrder: 0` (unit) and
`1` (integration), so each group runs with its own consistent pool config (unit first,
then the DB/server-bound integration tests).
**Why:** the error only appears when both projects load together (full `npx vitest run` /
the `test` workflow), NOT when you pass explicit file paths or run a single `--project`,
so it's easy to miss in targeted runs and only surfaces in the full suite.

# Parallel-harness-only flakes (green isolated + in CI)

Some integration files PASS in isolation (`EPHEMERAL_DB_WORKERS=1`, single worker) and in
CI (which runs each file isolated), but FAIL under the local 2-worker ephemeral harness due
to concurrent Chromium contention / PDF-byte non-determinism. Observed examples:
`tests/billing/zugferd-persistence.test.ts` ZFP.1 (`pdfHashMatch=false` re-render drift) and
one case in `tests/erstberatung.test.ts`. These are harness-concurrency artifacts, not logic
regressions — reproduce/triage them by re-running the suspect file ALONE with 1 worker before
assuming a code bug.
**How to apply:** when the full `test` workflow is red but the failing files are green
isolated + green in CI, treat it as a harness-parallelism flake, not a blocker for unrelated
work.
