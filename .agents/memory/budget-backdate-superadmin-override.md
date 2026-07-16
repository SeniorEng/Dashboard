---
name: Budget backdate superadmin-override attack surface
description: Where the overrideBackdateGuard bypass flag may legitimately appear and the gate semantics that keep the GoBD backdate lock revision-proof.
---

# Superadmin backdate-override for budget type-settings

The Task-#1623 backdating lock (see `budget-typesettings-backdate-guard.md`) can be
waived **punctually** via an `overrideBackdateGuard` option. An architecture
fitness test scans the production scope (`server` + `shared`) and allows the flag
in **exactly three files**:

1. the route request-gate (`server/routes/budget.ts`) — superadmin-only, reason ≥ 20 chars,
2. the SSoT bypass + audit writer (`server/storage/budget/preferences-storage.ts`),
3. the storage **facade** (`server/storage/budget-storage.ts`) — a pure *type* passthrough, no logic.

**Why:** GoBD — the lock must stay softenable at exactly one controlled entry; a
stray reference anywhere else is a potential silent second bypass point.

**Why the facade counts:** this codebase declares explicit interface signatures
(not `typeof`-derived), so the option field names appear literally in the facade
interface. That is a legitimate surface and MUST be in `OVERRIDE_ALLOWLIST`
(`tests/architecture/budget-backdate-override-surface.test.ts`), NOT an accidental leak.

**How to apply:**
- A new *caller* passing the option flows through the already-allowlisted facade type — no arch change needed.
- Only when you introduce a genuinely new legitimate surface do you extend `OVERRIDE_ALLOWLIST` (with a comment). Otherwise treat a 4th hit as a real violation.

**Gate semantics:** the bypass activates ONLY when all three core fields are set
(flag + actor userId + reason ≥ 20). Plain admin → 403 `SUPERADMIN_REQUIRED`;
reason < 20 → 400 `VALIDATION_ERROR`; no override on a backdated valued row → 400
`BUDGET_BACKDATE_NOT_ALLOWED`. The gate is enforced BOTH at the route AND inside
the SSoT storage fn (defense-in-depth): calling `upsertBudgetTypeSettings` directly
with the flag but a missing `overrideUserId` or a short reason still throws
`BudgetBackdateNotAllowedError`. Every successful override writes one revision-proof
`audit_log` row `action='budget_backdate_override'`, entityType `budget`, entityId
`customerId`, `metadata.{customerId,budgetType,reason,oldValidFrom,newValidFrom,before,after,...}`.

**Append-only vs in-place — GoBD nuance (do NOT "fix" to a true append):** "append-only"
here means phase BOUNDARIES. A backdate to a NEW validFrom clamps the predecessor
(`validTo = newValidFrom − 1`) and inserts a new phase. BUT if the backdated validFrom
EXACTLY equals an existing (possibly closed, historical) row's validFrom, the append
path's exactMatch branch UPDATES that row **in place** (`oldValidFrom === newValidFrom`,
window `validTo` unchanged) — because a second coexisting phase over the identical window
is not representable in this schema: `customer_budget_type_settings` has NO soft-delete
column, its partial unique index forbids two OPEN rows, and two CLOSED rows over the same
window would be an ambiguous phase. This is GoBD-legit for THIS config table: its
immutability trigger (`ensure-gobd-table-immutability.ts`) forbids only Hard-DELETE
(append-only = no row LOSS); UPDATEs are allowed and the value change is fully captured
by the immutable `budget_backdate_override` audit row (`before`/`after`). So a "never
in-place" claim is inaccurate — pre-#1792 that in-place branch was simply unreachable for
valued historical phases because the guard threw first.
