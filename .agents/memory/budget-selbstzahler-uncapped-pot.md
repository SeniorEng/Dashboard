---
name: Selbstzahler/private as uncapped terminal pot
description: Private payer is one uncapped terminal pot in the single cascade; plus a km-quantization blind spot in the selbstzahler equality test.
---

# Selbstzahler/private = uncapped terminal pot

Every customer routes through the one pure `planCascade`
(`shared/domain/budget/plan-cascade.ts`). Private payer / Selbstzahler is a
terminal pot carrying `uncapped: true` (never a literal ∞ amount); it absorbs the
whole remainder. There is no Selbstzahler fast-path and no separate
private-overflow branch.

**Rule — never read a numeric capacity from an uncapped pot.** `planCascade`
ignores `capacityCents` when `uncapped` is set. The property test feeds absurd
capacities (NaN/±∞/negative) and still expects outstanding 0.
**Why:** a single distributor with one terminal pot only stays correct if the
uncapped leg is driven by the boolean, not by a sentinel amount.

**Rule — no-private overrun raises a typed hard-block.** No private pot +
insufficient statutory ⇒ cascade leaves `outstandingCents > 0` ⇒ caller throws
`BudgetHardBlockError` (`shared/domain/budget/over-budget-error.ts`). Keep its
message starting with "Budget reicht nicht — …".
**Why:** route guards match this refusal via `message.includes("Budget reicht
nicht")`; changing the prefix silently breaks those guards.

## km-quantization blind spot in the equality test
The selbstzahler private-booking equality test books with **km = 0**, so it does
NOT exercise kilometer fields. The legacy Selbstzahler fast-path stored km RAW;
the unified path runs the private leg through `buildConsumptionTxData`, which
applies `quantizeKm` (2 NK, same ledger convention as the privatzahlung leg). For
fractional km the persisted value therefore changed (e.g. 12.347 → 12.35) — a
deliberate alignment, NOT byte-identical to the legacy fast-path on km. Cent
fields stay exact (ratio=1, subtract-last).
**How to apply:** uniform `quantizeKm` on all consumption legs is the intended
SSoT. If you ever need true byte-identical km behavior for legacy selbstzahler
rows, this equality test won't catch a regression — add a non-zero-km row.
