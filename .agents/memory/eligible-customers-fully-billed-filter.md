---
name: eligible-customers "fully billed" filter (no-date-range)
description: How to exclude fully-billed customers from GET /billing/eligible-customers WITHOUT hiding signature-blocked or late-signed ones
---

The no-date-range branch of `GET /api/billing/eligible-customers` (server/routes/billing.ts)
intentionally lists BOTH billable customers AND signature-blocked ones (so admins
see *why* a Pflegekasse customer with only `employee_signed` LN can't be billed —
guarded by tests/billing/eligible-signature-grouping.test.ts SIG-1).

**Rule:** exclude a customer only when they are FULLY billed, expressed purely via
the shared `getUnbilledSignedAppointmentFactsByCustomer` facts:
`signedAppointmentCount > 0 && unbilledAppointmentCount === 0`.

**Why:** `unbilled = strict-signed − already-invoiced`. So `unbilled === 0` alone is
ambiguous — it's ALSO true for a signature-blocked customer whose strict-signed
count is 0 (dropping them regressed SIG-1). Because `unbilled = signed − invoiced`,
`signed>0 && unbilled===0` happens IFF every strict-signed appt is invoiced (i.e.
an invoice exists) — so you get the "fully billed" test with NO separate
"has invoice?" query. A signature-blocked customer has `signed===0` ⇒ kept. A
late-signed straggler after an existing invoice has `unbilled>0` ⇒ kept (the bug
that was being fixed — the old coarse "has any active invoice → exclude" filter
hid these).

**How to apply:** never filter the no-date-range eligible list on "customer has an
invoice this month" or on `unbilled>0` alone. Filter on the fully-billed predicate
above. generate-all's per-customer skip runs AFTER signature-skip removes the
blocked ones, so there `unbilledAppointmentCount === 0` is safe as the
"Bereits abgerechnet" skip.
