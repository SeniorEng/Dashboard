---
name: Mitarbeiterabrechnung "Noch nicht abrechenbar" count↔list join drift
description: Why the payroll unsigned-appointments overview counter and its detail list must both tolerate customer-less appointments
---

# Payroll "Noch nicht abrechenbar" count must match its detail list

The overview counter (`unsignedAppointmentCount`/`unsignedMinutes`, SSoT in
`server/storage/time-tracking/payroll-hours.ts`) aggregates completed-but-unsigned
appointments per employee WITHOUT joining `customers`. The detail list and the
employee drill-down (`server/routes/admin/mitarbeiterabrechnung.ts`) used an
INNER JOIN on `customers`, so any appointment with `customer_id` NULL silently
fell out of the list while still being counted — an "Anzeige-gegen-Anzeige" drift.

**Why NULL customer_id is legit (not corrupt data):** the CHECK constraint
`appointments_prospect_or_customer_check` (`prospect_id IS NOT NULL OR
customer_id IS NOT NULL`) plus the FK on `customer_id` mean the ONLY real way an
appointment has no resolvable customer is a **prospect/Erstberatung appointment**
(prospect_id set, customer_id NULL). No orphaned FK reference is possible; a
soft-deleted customer STILL joins (the queries don't filter customers.deleted_at).

**How to apply:** any per-appointment listing that must mirror this counter uses
`LEFT JOIN customers` + a placeholder name ("Kein Kunde zugeordnet"), never INNER
JOIN. Keep the WHERE filters (period, deleted_at, employee, completedButUnsigned)
byte-identical to the overview aggregation so count === list by construction.
Guarded by `tests/mitarbeiterabrechnung-unsigned-count-list-parity.test.ts`
(seeds a prospect appointment via raw SQL to avoid budget_transactions that would
block cleanup via the GoBD trigger).
