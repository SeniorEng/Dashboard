---
name: Selbstzahler statutory-pot defense-in-depth
description: Storage-layer backstop blocking statutory pots for selbstzahler, plus its escape hatch
---
`upsertBudgetTypeSettings` (server/storage/budget/preferences-storage.ts) now THROWS `SelbstzahlerStatutoryPotError` (code BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER) when a `selbstzahler` customer gets an `enabled=true` statutory pot (§45b/§45a/§39+§42a) — not only the route gates this anymore.

**Why:** the invariant must not hang only on the route `rejectBudgetIntent`; direct storage callers that bypass the route would otherwise re-introduce ineligible statutory rows (prod legacy Kunde 41 history).

**How to apply:**
- Only `enabled=true` rows are blocked; deactivate/close payloads always pass (so legacy rows can be torn down).
- Statutory-pot detection reuses `validateSelbstzahlerBudget` with a `billingType:"selbstzahler"` probe — keep the pot whitelist ONLY in that validator, never copy it into storage.
- Legitimate seed/correction paths pass the 5th arg `{ allowStatutoryForSelbstzahler: true }` (clamp-over-limit script + test legacy seeds). Any new legacy/correction writer must opt in the same way or it will throw.

## Gotcha: reading customers in storage must go through the repo
The guard needs the customer's billingType. Reading it via `db.select().from(customers)` in a storage/service module FAILS the architecture fitness `tests/architecture/soft-delete-coverage.test.ts` — `customers` is soft-deletable, so the read MUST use `customersRepo` from `server/repos` (`findByIdIncludingDeleted(id, tx)` to keep the no-`activeOnly` semantics).

**Why:** the fitness function snapshots which repos each storage/service/route file uses and forbids any new direct `.from(<soft-deletable-table>)`.

**How to apply:** after legitimately adding a new repo usage to a storage/service/route file, re-record the snapshot with `npx vitest run tests/architecture/soft-delete-coverage.test.ts --project unit -u` and sanity-check the diff is only your file (it may also pick up unrelated pre-existing snapshot drift from earlier merges).
