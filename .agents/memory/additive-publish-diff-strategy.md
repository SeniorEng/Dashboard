---
name: Additive-only publish diff strategy
description: Replit publish auto-diff can emit a redundant DROP for an already-removed object and fail; keep each publish additive and verify dev vs the prod replica.
---

# Replit publish auto-diff: keep it additive, verify against the prod replica

When a schema change removes a DB object that another object cascade-depends on,
Replit's publish auto-diff can generate a migration that **first** cascade-removes
the dependent FK/object and **then** emits a *separate explicit* `DROP CONSTRAINT`/
`DROP` for that same object → the second statement fails with "… does not exist"
and the whole publish aborts. Nothing is applied (safe), but the deploy is blocked.

**Rule:** make every individual publish's schema diff **purely additive** (only
ADD table/column/FK/index, zero drops/alters of existing objects). If a removal is
needed, do it in a *separate, dedicated* later publish whose diff contains only that
removal. To turn a drop-containing diff additive, temporarily **restore the legacy
objects in the dev schema** (re-add the pgTable / column + FK) and neutralize any
startup DDL that drops them; defer the real cleanup.

**Why:** the failure is in Replit's generated migration ordering, not in our code;
we can only control it by controlling what the diff contains.

**How to verify the additive-only guarantee (do NOT trust the schema TS alone):**
diff dev against the **read-only prod replica** via `executeSql({environment:"production"})`
on `information_schema`/`pg_*`:
- tables + columns present in PROD but missing in DEV ⇒ would be DROPPED (must be empty)
- indexes / constraints / enum labels present in PROD but missing in DEV ⇒ DROPPED (empty)
- per-column `data_type|is_nullable|column_default` drift on shared columns ⇒ ALTER
Adds (in DEV not PROD) are safe. Two known noise sources: the prod replica appends a
trailing `ROLLBACK` line to query output (not a real constraint), and numeric default
literals differ cosmetically (`0` vs `'0'::numeric`, a harmless `SET DEFAULT` at worst).

**Gotcha:** the project's `timestamp` in `shared/schema/common.ts` is a wrapper that
already sets `withTimezone:true` and takes only a name — restoring a legacy timestamptz
column must call `timestamp("col")` (no options arg) or `tsc` breaks while `drizzle-kit
push` still works (JS ignores the extra arg), masking the type error.
