---
name: Ephemeral test-DB fail-fast guard
description: Why bare `vitest run` aborts and which paths may write to a test DB
---

# Ephemeral test-DB fail-fast guard

The integration test suite must never write to the dev DB. A fail-fast guard in
the integration project's globalSetup aborts the run unless the target DB is a
throwaway DB. It allows exactly three paths:

1. `CI === "true"` — CI uses a static `careconnect` DB behind the fixed-target
   Neon WS proxy; its db name is NOT `cc_test_*`, so CI can only be recognized
   by the env var, never by db-name (see ci-neon-proxy-fixed-target.md).
2. orchestrator signal present (`TEST_DATABASE_URLS`) — the local ephemeral-DB
   orchestrator provisions per-worker `cc_test_*` DBs.
3. effective `DATABASE_URL` db-name starts with the throwaway prefix `cc_test_`.

**Why:** a bare `npm run test` / `vitest run` inherits the dev `DATABASE_URL`,
and the per-worker DB re-routing only fires when the orchestrator vars are set —
so without the orchestrator ALL integration tests silently flood the dev DB
(observed thousands of test customers). Correct entrypoint is always the
orchestrator workflow, never bare vitest.

**How to apply:** keep the guard ONLY in the integration globalSetup. Do NOT put
it in the shared per-worker setup file — that file is also loaded by the unit
project (which never touches the DB), so guarding there would falsely block pure
unit runs. Source the `cc_test_` prefix from the ephemeral-db-sweep SSoT, never
hardcode.

**Open gap:** the dev app workflow boots the server in a test mode against the
dev DB; this guard only covers vitest, so anything hitting that server directly
can still write to the dev DB. A separate path likely still re-seeds it.
