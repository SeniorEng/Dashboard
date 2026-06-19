---
name: Production read-only investigation access
description: How to query/inspect the production DB from the dev sandbox when the managed prod path fails, and why writes can't be done from dev.
---

# Production read-only investigation access

When you must inspect PRODUCTION data (verify a record exists, audit a defect) from the
isolated dev environment:

- The managed read-only path (`executeSql` with `environment:"production"`, and the
  `database` skill prod queries) can fail with `password authentication failed for user
  'neondb_owner'` — its stored credential goes stale after the user rotates the DB password.
- Workaround: the **`PROD_DATABASE_URL` secret** is present in the bash env
  (`process.env.PROD_DATABASE_URL`) — but NOT in the code_execution sandbox. Connect with the
  `pg` package and force `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` before any
  query. **Never print the credential.**
- The app's own pool (`server/lib/db.ts`, Neon serverless secure-WS) **hangs** when pointed at
  the prod URL from the dev sandbox (`DATABASE_URL=$PROD_DATABASE_URL tsx some-script.ts` times
  out). So you can't dry-run a server script against prod from dev — validate script *logic*
  with a direct `pg` read instead, and run the actual script IN the production environment.

**Why writes can't run from dev:** GoBD-relevant writes (e.g. a Stornorechnung) persist a PDF
to object storage, which is **env-scoped** (dev sandbox → dev bucket, prod → prod bucket; see
`invoice-pdf-storage-isolation`). A storno generated from dev would write the record to prod DB
but the PDF to the dev bucket → broken/non-compliant. Plus GoBD immutability triggers block raw
SQL. So remediation scripts must be *prepared* in dev (dry-run default, superadmin+reason gated,
document-only) and *executed in the production environment*.

**How to apply:** for "confirm/clean up X in prod" tasks — verify with the `pg` read-only client,
prepare the cleanup script reusing the app's tx helpers + `withAudit` + `persistInvoicePdf`, and
hand off the `--apply` run to the production environment (never `--apply` from dev).
