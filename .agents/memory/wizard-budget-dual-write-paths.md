---
name: New-customer wizard §45b budget-write decisions
description: Non-obvious decisions about how the customer-creation wizard writes §45b budget data.
---

Durable decisions for the new-customer wizard's §45b budget handling:

- **The §45b euro amount in the create payload is an enable-signal only.** The
  create-payload `budgets` object writes `budget_type_settings` + carryover; its
  §45b numeric value is ignored (only `> 0` matters). The actual §45b
  `initial_balance` is written exclusively via `POST /budget/:id/initial-budget`.
  **Why:** keeps "is §45b enabled?" and "what is the starting balance?" as two
  independent concerns; conflating them double-writes or drops balances.

- **A §45b start-month `initial_balance` of one month's accrual (131 €) is
  net-equivalent to pure auto-renewal.** Auto-renewal already fills the start month
  when no initial_balance exists, so omitting the initial_balance (override OFF)
  leaves the net budget unchanged. **Why:** lets the wizard skip creating a
  redundant row by default and only write an initial_balance when the operator
  actively overrides the current-year remaining balance.

- **Carryover (Vorjahres-Übertrag) must be gated by the same contract-start rule in
  BOTH the UI visibility and the submit path.** It is only usable until 30.06., so
  when contract start >= 1 July it is hidden AND forced to 0 on submit.
  **Why:** a stale entered value otherwise still posts after the field is hidden.

- **Money conversions in client code go through `centsToEuroNumber`/`parseEuroDE`,
  never raw `<...Cents> / 100` or `Math.round(euros * 100)`.** An architecture test
  (`tests/architecture/no-money-arithmetic-outside-helper.test.ts`) fails on a
  variable named `*Cents` divided by 100 (all-caps `*_CENTS` constants slip the
  regex, mixed-case `fooCents` do not).
