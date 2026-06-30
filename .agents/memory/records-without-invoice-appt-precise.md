---
name: Records-without-invoice appointment-precise
description: The process-health "noch abzurechnen" safety net must be appointment-precise, not period-coarse.
---

**Rule:** the "noch abzurechnen" (records-without-invoice) process-health
net must decide per-appointment, not per customer-month. A completed
(customer-signed) Leistungsnachweis stays flagged while it still has >= 1
appointment that is on NO active invoice line. "Active" = the same billing
SSoT (`getAlreadyInvoicedAppointmentIds`): a line on an invoice whose
status is not `storniert` and whose type is not `stornorechnung`. So
storno / stornorechnung release their appointments back into the net.

**Why:** the original check was period-coarse ("any active invoice exists
for customer+billing_year+billing_month"). Once any invoice existed for a
customer-month, sibling proofs and partial-month leftovers with still
uninvoiced appointments silently disappeared — false negatives the office
is never prompted to bill (a prod snapshot found real cases).

**How to apply:** the KPI count, the sparkline, and the drill list are
three separate queries that must share ONE appointment-level predicate —
never re-hand-roll the appointment-vs-invoice check in one of them or
revert any to a period-level invoice-existence test. Count records with
`DISTINCT` so a record with several unbilled appts counts once. Known
accepted edge: a suppressed `customer_no_show` produces no line item, so it
reads as "unbilled" forever under the strict appointment criterion (see the
no-show follow-up).
