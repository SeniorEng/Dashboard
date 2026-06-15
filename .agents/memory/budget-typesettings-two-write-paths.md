---
name: Budget type-settings — one SSoT, several request callers
description: Why budget_type_settings has a single write path with multiple callers, and the parity-test traps that follow
---

# Budget-Type-Settings write path

`customer_budget_type_settings` has exactly ONE write path: the SSoT upsert
in the budget preferences storage layer (plus an idempotent "enable in place"
helper next to it). Several production request callers feed INTO that SSoT and
share the SAME pure validators (Selbstzahler-block, PG≥2 gate, statutory
maxima) — there is no per-caller second validation layer:

1. **PUT type-settings route** — full intent incl. limits.
2. **POST /admin/customers create** — wizard `budgets` payload mapped to
   type-settings, validated before the customer's related data is created.
3. **POST /:customerId/initial-budget** (`applyInitialBudget`) — sets an
   initial balance and ENABLES the pot idempotently via the same SSoT helper.

**Why parity holds:** all callers funnel through the shared validators + the
one SSoT upsert, so a cross-caller parity test only compares the resulting
rows / the reject status+code.

**Key asymmetry — the /initial-budget caller does NOT set limits.** It is a
pure enable + initial_balance intent (monthly/yearly limit stay null), so it
deliberately does NOT enforce the §45a/§39 maxima. Those maxima belong only to
the limit-setting intent (PUT route / create). So: assert reject-parity
(Selbstzahler 409, PG1 409, same codes) and enable-parity for this caller, but
do NOT expect §45a/§39 over-cap rejection from it.

**How to apply (test traps):**
- Create-route `budgets` schema REQUIRES `validFrom` + all three amount keys;
  a missing `validFrom` yields a generic VALIDATION_ERROR that can make reject
  tests pass for the wrong reason. Always send `validFrom`.
- The create path ALSO runs the initial-budget logic (initial balances,
  prior-year §45b guard), so it is NOT a pure type-settings writer. For
  type-settings parity use current-year dates and compare only the
  type-settings rows; the §45b euro amount is just an enable-signal.
- Shared reject codes: Selbstzahler + enabled statutory pot → 409
  `BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER`; §45a/§42a on PG1 → 409
  `BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD` (identical across all callers).

The architecture guard forbids any direct Drizzle/raw write to the table
outside the SSoT storage module + the customer soft-delete service; its scope
excludes tests/, scripts/, server/scripts/, server/startup/.
