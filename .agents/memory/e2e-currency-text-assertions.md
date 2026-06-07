---
name: e2e currency-text assertions break on narrow no-break space
description: Why Playwright/text regexes against German € strings fail, and what to assert instead
---

# Currency strings carry U+202F, not an ASCII space

`Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" })` (the
basis of `formatEuroDE`/`formatCurrency` in `shared/utils/money.ts`) renders
the amount with a **narrow no-break space (U+202F)** between the number and
`€` — e.g. `1.572,00\u202F€`, NOT `1.572,00 €`.

**Consequence:** any test that matches a currency-bearing string with a literal
ASCII space before `€` silently never matches. The classic trap is a regex like
`/Maximal .* € möglich/` — `.* €` requires an ASCII `0x20` before `€`, which is
not present, so `toBeVisible()` times out and the test fails deterministically.

**How to apply:**
- Prefer asserting on a dedicated `data-testid` element (the actual guard/error
  node) over text-matching a formatted currency string. This is whitespace-proof
  and also pins the assertion to the *right* element (e.g. the dedicated over-cap
  error vs. an always-on hint that happens to share a prefix).
- If you must match the text, allow any Unicode space before `€`
  (`[\s\u202F\u00A0]`) instead of a literal space, and remember `\s` in JS regex
  does cover U+00A0 but tooling/intent is clearer with the explicit class.

**Why:** ICU switched the EUR separator to U+202F; older code/tests written for
the old plain-space output break invisibly on upgrade.
