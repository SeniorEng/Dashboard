---
name: Create-invoice list drop guard is billing-aware, coverage is not
description: Why the "Noch zu erstellen" drop must use the billing-signature fact, not documentation-coverage
---

# Create-invoice list drop guard vs documentation coverage

The documentation-coverage reader (`getDocumentationCoverageByCustomer`) counts a
service record as "covered" for `status IN ('completed','employee_signed')`
**regardless of billing type**. But the billing signature gate
(`isServiceRecordSignedForBilling`) treats a Pflegekasse `employee_signed` LN as
NOT signed (customer signature required). These two disagree for Pflegekasse.

**Rule:** the "Noch zu erstellen" / create-invoice drop decision must be driven by
the billing-aware fact, never by coverage / `isPartiallyDocumented`. A customer is
dropped only when EVERY documented (`completed`) appointment in the month is
billable-signed AND already invoiced — SSoT `isMonthFullyBilledAndSigned`
(`completedAppointments > 0 && signedAppointmentCount − unbilledAppointmentCount >= completedAppointments`).
`signedAppointmentCount` already respects the billing-type gate, so this is
inherently correct for both Pflegekasse and Selbstzahler.

**Why:** the old guard (`signed>0 && unbilled===0 && !isPartiallyDocumented`) let a
Pflegekasse customer with one billed customer-signed appointment plus several
`employee_signed`-only appointments look "fully covered" and vanish silently while
his money still showed in the pipeline's "Wartet auf Kundenunterschrift" bucket
(the "Bernd Funke" symptom).

**Truthful label:** such a kept customer's eligibility mirrors `buildInvoiceDraft`
and returns `already_billed` (must not change — parity is unit-tested). Do NOT
retitle the reason. Instead override only the inline short-label via
`isAwaitingCustomerSignature` (Pflegekasse && coveredAppointments > signedAppointmentCount)
so the row reads "Kundenunterschrift fehlt", consistent with its `signature_blocked`
maturity group and the overview euro bucket (#1874).
