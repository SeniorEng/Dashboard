---
name: Validation-env concurrency flakes vs CI
description: Why some integration tests fail only in the agent validation harness and not in CI, and how to verify them.
---

The agent validation harness auto-runs the `test`, `e2e-smoke`, and `Start application`
workflows CONCURRENTLY. CI runs each as an isolated job. This difference produces
failures that are NOT real CI failures:

- **PID pressure**: container cgroup `pids.max` ~= 1024. Concurrent ephemeral-DB
  workers + Chromium PDF renders + e2e browsers exhaust it → `spawn EAGAIN`,
  ECONNREFUSED, or servers that never reach `startupComplete`. Environmental, not logic.
- **Concurrent-insert count races**: `tests/test-data-cleanup.test.ts` asserts
  `summary.*Deleted == countDisappeared(before, after)`. The parallel `test`
  workflow constantly inserts test-pattern rows; a row inserted in the window
  between the `before` snapshot and the purge gets deleted+counted but is not in
  `before` → mismatch. The test's own comments (lines ~35-38) document that this is
  deterministic/green in CI (sequential, alone). Verify in isolation, not in the harness.
- **Timing flakes**: `tests/services.test.ts` concurrency cases
  (`priceCents=-1`, parallel-POST Sonderpreis-Konflikt) fail nondeterministically —
  a DIFFERENT case fails each run. Pre-existing, timing-based.

**How to verify cleanly**: run the suspect file with raw vitest against the running
dev server (`NODE_ENV=test npx vitest run --project integration <file>`, base URL
defaults to localhost:5000). Other workflows use ephemeral DBs, so the dev DB sees no
concurrent inserts → count invariants hold and you get a true signal. Background
nohup/setsid runs in this env get killed and their /tmp logs vanish; prefer
synchronous foreground runs.

**Why:** repeatedly chased "failures" that were just the harness's concurrent
fan-out, wasting time re-running the orchestrator. Trust the per-file isolated run
and the test's own concurrency-immunity comments over the noisy harness aggregate.
