---
name: Sammel-LN on-demand model
description: Monthly/Sammel Leistungsnachweis creation is on-demand & non-merging; coverage-exclusion is race-safe via row-lock; sealed-never-mutated + overview-array invariants.
---

# Sammel-Leistungsnachweis (LN) — on-demand creation model

**Model (on-demand, no merge).** `POST /api/service-records` (monthly create) creates a
**separate** Sammel-LN each call. No auto-growing monthly container, no merge-into-existing-
pending. The employee picks which documented appointments of a month go on the proof
(`appointmentIds` optional; omitted ⇒ all still-uncovered documented appts of that
customer+employee+month). The `monthly` `record_type` is reinterpreted as "Sammel-LN" — no
enum delete/mutate (GoBD). `/single` creates a one-appointment LN.

**Coverage-exclusion is app-level, made race-safe by a transactional row-lock — NOT a DB
constraint.** A `serviceRecordAppointments` row on a non-soft-deleted `monthlyServiceRecords`
covers an appt (soft-deleted LN's junction rows persist but don't count, so the appt is
re-addable). The junction's only unique is `(serviceRecordId, appointmentId)` — that does NOT
enforce "one appt in one LN". A plain unique index on `appointment_id` is WRONG (soft-deletes
must free the appt; a partial index can't reference the parent's `deletedAt`).
**The guard is: inside the create tx, `SELECT … FOR UPDATE` the claimed appointment rows
(ordered by id, dedup — `lockAppointmentsForUpdate`), then re-run the coverage read
(`getAppointmentIdsInServiceRecords`, tx-bound) and abort with 409 if any is now covered,
before create+link.** Coverage is global per appt (across employees), so locking the appt row
— the actually-contended resource — serializes two creates regardless of `effectiveEmployeeId`.
Both `POST /` and `POST /single` do this.

**Route 400 ordering (POST /):** undocumented → documented-empty → remaining-empty ("bereits
abgedeckt") → appointmentIds-invalid (`invalidAppointmentIds`) → [tx] now-covered → 409. So to
hit the invalid-id branch a test needs ≥1 still-open appt (else remaining-empty 400 fires
first). A concurrent-create loser is 400 (pre-tx caught it) OR 409 (tx re-check caught it) —
never a second 201.

**Durable invariants (preserve):**
1. **Sealed-never-mutated.** `employee_signed`/`completed` are GoBD-sealed; a sealed LN is
   NEVER mutated — a later create just makes a new LN.
2. **Overview keeps every proof.** Overview storage returns `monthlyRecords: {id;status}[]`
   per customer; never collapse multiple proofs into one slot or a second proof vanishes.
3. **Per-employee separation** and **race-safe coverage-exclusion** hold across all write paths.

**How to apply:** any new write path attaching appointments to a Sammel-LN MUST lock the appt
rows + re-check coverage inside the same tx, respect the sealed boundary, and treat overview
`monthlyRecords` as an array.

## Known remaining gap (deferred)
- **appointment-MUTATION lock-check TOCTOU** — `isAppointmentLocked` is a correct pure read,
  but callers in `server/routes/appointments.ts` / `appointment-documentation.ts` /
  `appointment-series.ts` check-then-write: a concurrent sign can seal the LN between check and
  edit/delete (junction ON DELETE CASCADE → would mutate a sealed proof). Fix = lock the related
  `monthlyServiceRecords` rows in the mutation tx and re-check inside it. (This is the mutation
  side; the create side is now race-safe as above.)
