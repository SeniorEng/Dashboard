---
name: Rate-literal magic-number guard
description: How prices/wages/km-rates are kept SSoT-only and the guard that enforces it
---

Every displayed/calculated price, wage, or km-rate MUST come from the SSoT resolvers (`priceFor`/`wageFor`) or the catalog/price/wage tables (`shared/config/services.ts`, `prices`, `role_wage_rates`) — never a hardcoded number or dummy fallback.

The distinctive catalog cents literals (HW 3800/1600, AB 4200/1800) and km-rate cents (35/30) live legitimately in ONLY two places: the catalog SSoT `shared/config/services.ts` and the one-off recovery script `server/startup/recover-prices-from-backup.ts` (expected-value asserts). Everywhere else they are a bug.

**Why:** an app-wide audit (triggered by an economics screenshot showing 38€/16€/0,35€ rates) confirmed those rates actually come from the `services` table — correct — but nothing prevented a future regression that hardcodes one. Prior consolidations already made the architecture clean (one price resolver, one wage resolver, table-driven economics readers, km-fallback removal); the audit found ZERO value-changing bugs and ZERO hardcoded rates in live paths.

**Guard:** `tests/architecture/calculations-in-shared.test.ts` scans server/client/shared for the catalog cents literals + km-rate fallback/assignment patterns, gated on a money keyword on the same line to avoid false positives (vacation `?? 30`, margin colors `>= 30`, timeouts `1800`). Escape hatch: `// rate-literal-allowed: <reason>`.

**How to apply:** When adding a money/rate path, resolve via `priceFor`/`wageFor` or read the table — never write a rate literal. A new legitimate literal location must be added to the test's allowlist (not silently worked around) or use the inline escape with a reason. Never change actual table values or legal constants (§45b 131€, §39/§42a, VAT) to "fix" a display. The full audit inventory lives in `docs/price-wage-km-rate-audit.md`.
