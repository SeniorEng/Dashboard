---
name: audit_log INSERT schema trap
description: The real audit_log columns differ from the old startup-migration copy-paste pattern; copying it silently writes nothing.
---

The canonical `audit_log` table (shared/schema/audit.ts) has:
- `user_id` integer **NOT NULL** with FK → users.id
- payload column is **`metadata`** (jsonb), NOT `changes`
- `action`, `entity_type`, `entity_id`, `created_at`

**Trap:** older startup migrations (e.g. migrate-in-progress-appointments) INSERT with
`(... changes, user_id ...) VALUES (... <json>, NULL ...)` wrapped in `.catch(() => {})`.
Against the current schema this INSERT **always fails** (no `changes` column + NOT NULL/FK on
user_id) and the error is swallowed — so those migrations write ZERO audit rows. Do not copy
that pattern expecting audit entries.

**How to apply:** when a startup migration must write audit rows, resolve a system actor first
(`SELECT id FROM users WHERE is_active ORDER BY is_super_admin DESC, is_admin DESC, id ASC LIMIT 1`,
mirroring month-close-scheduler's findSystemActorId) and INSERT into the **`metadata`** column with
that non-null user_id. audit_log is append-only (raising BEFORE triggers) but INSERT is allowed.
