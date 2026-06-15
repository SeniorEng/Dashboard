---
name: Budget type-settings read mode (forDate vs forEdit)
description: Which read mode value-relevant budget paths must use, and why the rebook preview is the one deliberate forEdit caller.
---

# Budget type-settings read mode — forDate vs latest-intent

`customer_budget_type_settings` is versioned. The single read entry
`readBudgetTypeSettings(customerId, mode, tx?)` has three modes:
`{ kind: "forDate", asOfDate }`, `{ kind: "forEdit" }`, `{ kind: "withTransition" }`.

## Rule
- **Every value-relevant read uses `forDate` at the appointment/transaction date.**
  That covers consumption booking, availability/overview, reservation, cap/allocation
  reads, and the rebook *execution* (single-transaction rebook reads forDate at the
  original `transactionDate`).
- **`forEdit` / `withTransition` (latest intent, incl. future-dated rows) are for
  edit/display ONLY:** the settings-edit GET endpoint (`withTransition`, transition
  banner) and the rebook *preview* operator view "which pots are disabled NOW"
  (`getRebookPreview`, `forEdit`).

**Why:** a booking with a past `transactionDate` must respect the config that was
active then (GoBD), not today's or a future-dated intent. Mixing latest-intent into a
booking/preview path makes the preview and the actual booking drift apart (audit
finding C-03).

## Why the rebook preview using forEdit is NOT a drift bug
The disabled-pot rebook *execution* (`rebookDisabledBudgetTransactions`) derives its
work from the SAME `getRebookPreview` function, and the re-booking itself runs through
the `forDate` cascade. So preview and execution share one source and cannot diverge.
The forEdit there is the deliberate "which pots did the operator just disable" view.

## How to apply
- New booking/availability/ledger read of type-settings → pass
  `{ kind: "forDate", asOfDate }`, never `forEdit`/`withTransition` or the
  `@deprecated` `getLatestBudgetTypeSettings[WithTransition]` wrappers.
- This is statically guarded by `tests/architecture/budget-typesettings-read-path.test.ts`
  (allowlist: preferences-storage resolver, budget-storage facade, rebook-storage
  preview, routes/budget.ts settings-edit endpoint). A value path that switches to
  latest-intent breaks the build.
