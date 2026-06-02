---
name: Ephemeral test-DB parallelism & PID ceiling
description: Why integration test workers are capped low, how fresh-DB isolation breaks tests, and how to verify runs in this container.
---

# Ephemeral throwaway test DBs + fileParallelism (CareConnect)

The integration test workflow runs via `scripts/with-ephemeral-db.ts`: builds one
seeded template DB, clones a throwaway DB per vitest worker, and gives each worker
its own dedicated app-server (per-worker `DATABASE_URL`/`TEST_BASE_URL` routed in
`tests/setup.ts` by `VITEST_POOL_ID`).

## Parallel worker count is capped by the container PID ceiling
**Rule:** default to a LOW number of parallel test workers (currently 2), overridable
via `EPHEMERAL_DB_WORKERS`.
**Why:** the container cgroup sets `pids.max=1024` (user.slice budget ~1000). Each
worker is a full app-server that can spawn Chromium for PDF renders; when the `test`
workflow runs concurrently with `e2e-smoke` (Playwright browsers) and `Start
application`, the combined process/thread count exceeds the ceiling → `spawn EAGAIN`
kills whole vitest workers, and EVERY file on a dead worker reports as "failed". This
looks like a mass test regression but is pure resource exhaustion, not logic.
**How to apply:** if you see a burst of unrelated test-file failures plus `EAGAIN`
/ "Worker exited" in the log, suspect the PID ceiling first. Don't bump workers high
for the local workflow (it must coexist with the other workflows). Also cap
`PDF_RENDER_CONCURRENCY=1` per worker. Higher parallelism is fine only on isolated
CI runners (one job = one fresh runner).

## Fresh isolated DBs expose tests that relied on shared accumulated data
**Symptom:** a test does `GET /api/customers` (or employees/appointments) and uses
`data[0]`, or hard-codes a record id (e.g. `customer_id=14`). Passes on the old shared
dev DB (which had organically accumulated rows), fails on a fresh isolated DB (0 rows
/ FK violation).
**Fix (test/seed setup only):** create the needed data in `beforeAll` via the
`createTestCustomer()` helper in `tests/test-utils.ts` and clean up with
`cleanupCustomer()` — do NOT weaken assertions or change domain logic.

## Verifying runs in this environment
**The workflow-log capture (`/tmp/logs/test_*.log`) is unreliable for fresh results**
— it re-snapshots the last-completed run with a frozen mtime, so it can show a stale
older run even when a workflow "finished/failed" again. `restart_workflow` on
`test`/`e2e-smoke` tends to time out. Detached/`setsid`/`nohup` background runs get
killed when the bash tool's cgroup scope tears down.
**Only reliable method:** a SYNCHRONOUS bash run inside one tool call (≤120s) with an
internal `timeout --signal=TERM <~100>` (so the orchestrator's DB/server teardown
fires before the hard kill), output to a file, then grep in the same call. Setup
(template push + per-worker clone + server boot) is ~40-60s, leaving ~40-50s of test
budget → run small file subsets only.
