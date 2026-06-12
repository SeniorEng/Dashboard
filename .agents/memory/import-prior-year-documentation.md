---
name: Prior-year import = documentation-only
description: Why/when an Excel-imported appointment is booked without touching budget, and the import-test fixture traps.
---

# Vorjahres-Import = nur Dokumentation

Rule SSoT: `shared/domain/import-documentation-only.ts` → `isDocumentationOnlyImport({date, isPrivatePaymentAllowed})` (+ `isPriorYearImportDate`).
A row is documentation-only iff: the date is in a calendar year BEFORE the current year AND the customer is NOT privately billable. "Privately billable" = `acceptsPrivatePayment` true OR `billingType === "selbstzahler"`, resolved once per run by `loadPrivatePaymentAllowed` and shared by preview + execution.

**Why:** §45b/Pflege budget of a past year is floored to the current year (`floorAutoAnchor45bToCurrentYear`), so a backdated import finds 0 available budget and would wrongly trim/block ("Budget reicht nicht"). Documentation rows create appointment + services (completed, signed, count as geleistete Stunden) but book NO consumption. Selbstzahler/privatzahler route their overflow into the uncapped private pot → real receivable, so they stay on the normal billable path.

**How to apply:** preview (`enrichWithBudgetInfo`) and execution (`executeImport`) BOTH decide via the same `isDocOnlyRow` helper (built on `loadPrivatePaymentAllowed` + `isDocumentationOnlyImport`); the decision is recomputed server-side, never trusted from the client payload. `importSingleRow` takes `skipBudgetConsumption` for doc rows (creates the appointment record, returns before `createConsumptionTransaction`). Result counter is `documentationOnly`; the preview marks `row.documentationOnly`. Update/upgrade branches guard the fresh-booking path with `!isDocOnlyRow(row)` so a doc row never back-fills consumption.

## Import-test fixture traps (cost real debugging time)
- `createTestCustomer` (tests/test-utils.ts) DEFAULTS `acceptsPrivatePayment: true`. A "pflegekasse_gesetzlich" test customer is therefore privately-billable unless you pass `acceptsPrivatePayment: false` — otherwise documentation/trim logic silently won't fire.
- The importer flags **weekend** appointment dates as `status: "error"` (`isWeekend` guard in appointment-import.ts). Year-anchored test dates (`${priorYear}-06-15`) land on different weekdays per run; roll forward to the next weekday or the row is `error`, not `new`.
