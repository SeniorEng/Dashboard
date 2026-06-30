---
name: Monthly-LN pending-merge SSoT
description: How duplicate monthly Leistungsnachweise are prevented (pending-merge + sealing invariant + overview array).
---

# Monthly Leistungsnachweis (LN) — duplicate prevention

The duplicate-monthly-LN bug had two roots, fixed together:

1. **Creation merged, not duplicated.** `POST /api/service-records` (monthly create)
   merges newly documented appointments into an existing **PENDING** monthly LN for the
   same customer+employee+month instead of creating a second pending LN.
   `employee_signed`/`completed` are **GoBD-sealed** — a sealed LN is NEVER mutated, so
   later appointments correctly get a brand-new LN.

2. **Overview must keep every proof.** The overview storage returns
   `monthlyRecords: {id; status}[]` per customer. The old code collapsed multiple monthly
   proofs into a single map slot, so a second proof was invisible. Frontend renders
   awaiting-signature **per proof**, not per customer.

**Why the FOR UPDATE matters (rule):** the pending lookup
(`getPendingMonthlyServiceRecord`) MUST run **inside** the create `db.transaction`, and in
tx context it issues `SELECT … FOR UPDATE` on the matching pending row. Otherwise a
concurrent signature can seal the LN between "found pending" and "append appointments",
mutating a sealed (GoBD) record. With the lock + `status='pending'` filter: a sealed row is
excluded (→ new LN), and merge-vs-merge serializes on the same row.

**How to apply:** any new write path that attaches appointments to a monthly LN must (a)
respect the sealed-never-mutated boundary and (b) take the pending row under FOR UPDATE in a
tx. Any reader of the overview must treat `monthlyRecords` as an array.

**Sign+merge confirmed race-safe (tested).** The sign double-apply is resolved: signing is
an atomic conditional `UPDATE … WHERE status=<expected>` (one racer transitions, the other
hits 0 rows → 400), and merge takes the pending row under FOR UPDATE. Both PG READ-COMMITTED
orderings leave the merged appointment on exactly one record (merge-first → appended then
sealed; sign-first → sealed then merge makes a new pending LN). Covered by the LN-16
concurrent merge+sign test in `tests/service-records.test.ts`.

**Known remaining gaps (deferred, NOT a sign race):**
1. **merge+merge double-create** — if NO pending row exists yet, two simultaneous *creates*
   can each make a pending LN (FOR UPDATE can't lock a not-yet-existing row). Durable
   closure = a partial unique index on (customerId, employeeId, year, month) WHERE
   recordType='monthly' AND status='pending' AND deleted_at IS NULL (idempotent startup
   migration, not drizzle-kit push; requires cleaning existing prod duplicates first).
2. **appointment-MUTATION lock-check TOCTOU** — `isAppointmentLocked` is a correct pure read
   of committed state, but callers in `server/routes/appointments.ts` /
   `appointment-documentation.ts` / `appointment-series.ts` check-then-write: a concurrent
   sign can seal the LN between the check and an edit/delete (junction has ON DELETE CASCADE
   → would mutate a GoBD-sealed proof). Fix = lock the related monthlyServiceRecords rows in
   the mutation tx and re-check inside it.
