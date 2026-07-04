---
name: Import billed/signed protection SSoT
description: The one "may an import overwrite this appointment?" reader and why reconcile only uses half of it.
---

# Billed/signed appointment protection SSoT

`getMutationProtectedAppointmentIds(ids, txClient=db)` (in
`server/services/appointment-billing-protection.ts`) is the single reader for
"is this existing appointment sealed against import overwrite/rebook because it
is already billed?". It returns an `AppointmentProtectionResult`:
`{ protectedIds, signedServiceRecordIds, invoicedIds }` (all `Set<number>`).

- `signedServiceRecordIds` = appt on a non-deleted `monthly_service_records`
  row with `employeeSignedAt` OR `customerSignedAt` set (join via
  `service_record_appointments`).
- `invoicedIds` = appt as a line item on an invoice that is NOT `storniert` and
  NOT `invoiceType='stornorechnung'` (draft/`entwurf` invoices are deliberately
  INCLUDED — same rule as `invoice-data.ts`).
- `protectedIds` = the union (signed OR invoiced).

**Why:** consolidated two previously separate checks (the inline
`signed_service_record` query in the reconcile path + the invoice-side logic)
into one function — Ersetzungs-Regel / one SSoT per question, no second parallel
detection.

**How to apply:**
- The main Excel importer (`appointment-import.ts`) consumes the FULL
  `protectedIds` union (any protected appt → row flagged `billedProtected`,
  action forced to `noop`/`skip`, never update/upgrade), re-checking inside the
  execute transaction as defense-in-depth.
- The reconcile path (`appointment-import-reconcile.ts`) deliberately consumes
  ONLY `signedServiceRecordIds` — its cancellation behavior must stay identical
  to before this SSoT existed, so an invoiced-but-unsigned appt is still a
  cancellation candidate there. Wiring the `invoiced` dimension into reconcile
  would be a behavior change, not a refactor.
- The row/result/action layer (`shared/domain/import-appointment-action.ts`,
  `MatchedRow`/`ImportResult`) carries a boolean field `billedProtected`;
  `classifyImportAction` → `noop` and `actionWhenSelected` → `skip` when set.
- Any NEW bulk appointment-mutation path should reuse this reader rather than
  re-deriving "is it billed/signed".
