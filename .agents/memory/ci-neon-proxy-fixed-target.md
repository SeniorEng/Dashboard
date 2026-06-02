---
name: CI Neon-Proxy is a fixed-target bridge
description: Why CI test/verify jobs can't route per-DB through the local Neon WS proxy, and the provision-only escape hatch
---

The CI `local-neon-http-proxy` (`NEON_LOCAL_WS_PROXY`) is configured with ONE
`PG_CONNECTION_STRING` and bridges every Neon-driver connection to that single
target DB — it IGNORES the database name in `DATABASE_URL`. So anything that uses
the Neon serverless driver (`server/lib/db.ts`, and therefore the App-Server boot
and the seed scripts) always lands on that one DB in CI, no matter which per-run
DB the ephemeral-test orchestrator created.

**Consequences:**
- The ephemeral orchestrator's per-worker app-server boot canNOT be routed
  per-DB in CI behind this proxy. Verifying the seeded cache-template mechanism
  (push→hash→clone) must therefore run WITHOUT booting an app server.
- `drizzle-kit push` and `psql` connect DIRECTLY via the plain postgres URL (not
  the Neon driver), so they DO hit the right DB — the cache-build path (push into
  the cache DB, COMMENT hash, CREATE DATABASE … TEMPLATE clone) works correctly
  on direct connections.
- Seed scripts use the Neon driver → they hit the proxy's fixed target. Give that
  fixed target (`careconnect`) a schema first (`drizzle-kit push --force`) so cold
  seeds don't crash; warm runs skip seeds entirely.

**Escape hatch:** `EPHEMERAL_PROVISION_ONLY=1` makes the orchestrator stop right
after the template DB is provisioned (before bundle/server-boot/tests) and emit a
machine-readable `[ephemeral-db] CACHE_RESULT=warm|cold|disabled` marker. That is
what the cache-verify path keys off — no app server, no proxy routing problem.

**How to apply:** When testing/verifying ephemeral-DB or cache machinery in CI,
prefer provision-only + direct psql assertions over anything that needs a live
app server reachable per-DB. Don't assume `DATABASE_URL`'s db name reaches the
intended DB through the Neon proxy.
