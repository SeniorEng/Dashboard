---
name: Workspace bloat (freezing/preview-loss) = orphaned per-run test build artifacts
description: Why the live workspace (not the publish image) fills up, where it lives, and the durable auto-sweep + its safety guards
---

# Workspace bloat freezing the Repl ≠ publish-image bloat

Two SEPARATE size problems, do not conflate:
- **Publish image > 8 GiB** → `.replitignore` + Puppeteer userDataDir (see
  `chromium-userdatadir-image-bloat.md`). `.replitignore` only shrinks the DEPLOY
  image; it does NOT free the live workspace.
- **Live workspace freezing / broken preview+shell** → the on-disk workspace
  itself fills up. The workspace lives on `/dev/vdd` at `/home/runner/workspace`
  (NOT the tiny `/home/runner` overlay) — check the right mount with `df`.

## Root cause of the recurring live-workspace bloat
Hard-killed test runs (OOM, manual stop, crash) leave **per-run build artifacts**
in `.local/`:
- `test-server-<runId>.cjs` (bundled server, ~tens of MB each)
- `test-client-<runId>/` (static client build, ~tens of MB each)

The ephemeral-DB orchestrator's teardown only deletes these on a CLEAN exit, so
every crash strands a pair. Hundreds accumulate → multiple GB. This is the main
recurring offender (DBs/logs/processes are the PID story, see
`ephemeral-test-db-pid-ceiling.md`).

**Distinguish runId artifacts from per-worker logs:** `test-server-<runId>.cjs`
(artifact) vs `test-server-<port>.log` (log, ends `.log`) — the artifact matcher
must NOT eat the logs.

## Durable fix: auto-sweep on every orchestrator boot + manual unblock
One SSoT sweep lib drives both `scripts/with-ephemeral-db.ts` (every test run
startup) and `scripts/sweep-test-dbs.ts` (`npm run test:unblock`).

**Safety guards that MUST stay intact (an over-eager sweep deletes a running
sister run's bundle and kills it mid-flight):**
1. **runId-liveness is the primary guard:** an artifact is deleted only if no
   running `node .local/test-server-<runId>.cjs` process references its runId.
   The bundle mtime is written ONCE at build time and NOT refreshed during the
   run, so a long run has an OLD bundle — age alone cannot protect it.
2. **Always-on bootstrap floor** (`ARTIFACT_FORCE_FLOOR_MS`, 60s) that applies
   even in `--force`/`minAgeMs<=0`. Covers the window where the bundle is written
   but the server isn't yet visible in `ps`, so a concurrent `test:unblock` can't
   delete a just-starting run's artifacts. Effective age = `max(minAgeMs, floor)`.
3. **Process-sweep BEFORE artifact-sweep** in both callers. Killing orphan
   processes first frees their runIds; the artifact sweep then re-enumerates a
   fresh process list and cleans those artifacts in the SAME invocation.

**Why:** support ticket reported ~6 GB freezing the workspace; one-time delete
freed ~3.3 GB but without the auto-sweep it just comes back after the next crash.
