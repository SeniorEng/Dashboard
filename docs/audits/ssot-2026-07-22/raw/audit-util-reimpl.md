# Audit: Re-Implementations of Shared Utilities (CareConnect)

Date: 2026-07-22
Scope: `client/src/`, `server/`, `shared/` — excluding `tests/`, `e2e/`, `client/src/components/ui/**`, `server/replit_integrations/**`, `scripts/`, `server/scripts/` (CLI allowlist of the money guard).

Canonical helpers read first:
`shared/utils/money.ts` (`centsToEuroNumber` :27, `formatEuroDE` :44, `parseEuroDE` :71),
`shared/utils/format.ts` (`formatCurrency` shim :23, `formatKm` :40, `parseGermanDecimal` :51, `formatVacationDays` :65),
`shared/utils/datetime.ts` (`parseLocalDate` :46, `formatDateISO` :55, `todayISO` :65, `addDays` :72, `isWeekend` :92, `formatDateForDisplay` :103, `formatGermanDate` :162, `startOfWeekMonday` :171, `lastDayOfMonth` :370, `currentYearAndMonth` :380, `parseTimestamp` :398),
`shared/utils/holidays.ts`, `shared/utils/parse-german-decimal.ts` (`parseGermanDecimal` :33),
`shared/utils/phone.ts`, `shared/utils/month-close-cutoff.ts`, `shared/utils/zod-german.ts`,
`shared/domain/invoice-vat.ts` (`serviceVatRateBP` :52, `resolveVatTreatment` :75, `grossUpUnitPriceCents` :138).

Method: ripgrep sweeps for (a) `Intl.NumberFormat` / `toLocaleString("de-…")`, (b) `/100`, `*100`, `toFixed(2)`, (c) `toISOString().slice/split`, (d) `getFullYear()…padStart` date building, (e) `getDay()`, (f) `replace(",", ".")`, (g) phone regexes/`+49` handling, (h) `setErrorMap`/holiday names. Every candidate site was opened and read before being reported. The repo's own architecture guard `tests/architecture/no-money-arithmetic-outside-helper.test.ts` was re-implemented in a standalone Node script and run against the tree (vitest itself not installable in this sandbox).

---

## Finding 1 (HIGH) — Raw `service.vatRate` gross-price math in customer wizard, evading the Task #1659 SSoT and its architecture guard

- Duplicate: `client/src/features/customers/components/wizard/budgets-contract-step.tsx:463-472`
  ```ts
  const netPrice = centsToEuroNumber(service.defaultPriceCents);
  const displayPrice = showGrossPrices
    ? netPrice * (1 + (service.vatRate || 0) / 100)   // line 466
    : netPrice;
  ...
  {displayPrice.toFixed(2)} {unitLabel}               // line 472
  ```
- Canonical: `shared/domain/invoice-vat.ts:52-68` (`serviceVatRateBP` — "EINZIGE Roh-Zugriffsstelle auf `services.vatRate`") and `shared/domain/invoice-vat.ts:138-141` (`grossUpUnitPriceCents` — integer-cents BP math).
- Divergence:
  - Float euro math (`netPrice * 1.19`) instead of integer-cents BP math (`round(netCents * 11900 / 10000)`) → 1-cent display drift vs. the invoice's "Satz (brutto)" column for some prices.
  - `(service.vatRate || 0)` silently treats a missing VAT rate as tax-free — exactly the behavior invoice-vat.ts forbids ("NIE still als steuerfrei (`|| 0`) geschluckt", it throws instead). Wizard shows net price as gross; the later invoice throws or shows a different price.
  - `.toFixed(2)` renders "38.00 €/Std." (English decimal) instead of formatEuroDE's "38,00 €".
- Guard evasion: `tests/architecture/no-raw-service-vat-rate.test.ts` matches `\.vatRate\s*[*/]`; here `.vatRate` is followed by `||`, so the `|| 0` fallback slips through pattern A, and pattern B (`* / followed by operand ending in .vatRate`) also misses the parenthesized form.
- Remediation: compute `grossUpUnitPriceCents(service.defaultPriceCents, resolveVatTreatment(...))` (or `serviceVatRateBP`) in cents, format with `formatEuroDE`. Extend the guard with a pattern for `\.vatRate\s*\|\|` and `\(\s*\w+\.vatRate[^)]*\)\s*/\s*100`.

## Finding 2 (HIGH) — Euro-input parsing re-implemented with `parseFloat`/`Number` in booking-relevant client forms (parseEuroDE bypass; German comma silently truncated)

- Duplicates:
  - `client/src/components/budget/BudgetLedgerSection.tsx:1111` — manual budget adjustment (a booked ledger transaction!): `const amountCents = Math.round(parseFloat(amount || "0") * 100);`
  - `client/src/features/billing/components/reduce-45b-dialog.tsx:41-47` — local `parseEuroToCents`: `raw.trim().replace(/\s/g,"").replace(",", ".")` then `Math.round(euro * 100)`.
  - `client/src/features/customers/hooks/use-customer-wizard.ts:352, 357, 362-364` — budget create payload: `Math.round(parseFloat(formData.uebertrag45b) * 100)` etc.
  - `client/src/features/customers/components/wizard/budgets-step-validation.ts:43-49, 66-71, 92-94, 99-104` — same `parseFloat(...)`/`Math.round(x * 100)` pattern in the step validation.
  - `client/src/features/customers/components/wizard/budgets-contract-step.tsx:44-46, 83, 110, 120` — same pattern for on-screen cap checks.
- Canonical: `shared/utils/money.ts:71-96` (`parseEuroDE` — handles "125,50", "1.234,56", "125.50", "125 €").
- Divergence:
  - `parseFloat("125,50")` = **125** → BudgetLedgerSection books 12500 cents for an input of "125,50 €": the cents are silently dropped from a persisted budget transaction.
  - `parseEuroToCents("1.234,56")` → `Number("1.234.56")` = NaN → valid input rejected; `parseEuroToCents("1.234")` (German thousands) → 1.234 € = 123 cents instead of 1 234,00 €.
  - `parseEuroDE` returns 12550 / 123456 / 123400 correctly for all of these.
- Guard status: replicating the money guard's regexes over the current tree flags `reduce-45b-dialog.tsx:46` (`Math.round(euro * 100)`) — i.e. the checked-in gate is red on this line today. The other sites evade the guard because the euro variable is named `amount`/`uebertrag`/`rest`/`v45a` (pattern 3 requires an `euro`-ish name).
- Remediation: route every euro `<input>` through `parseEuroDE`; treat `null` as validation error. Tighten guard pattern 3 to `Math.round(<any-ident> * 100)` inside `client/src/**` form handlers, or add an ast-grep rule for `parseFloat($X) * 100`.

## Finding 3 (HIGH) — Two diverging canonical `parseGermanDecimal` implementations inside shared/utils itself

- Duplicate #1 (weak): `shared/utils/format.ts:51-58` — `String(value).trim().replace(",", ".")` + `parseFloat`. No thousands handling, no unit stripping.
- Duplicate #2 (robust, documented SSoT "Task #819"): `shared/utils/parse-german-decimal.ts:33-96` — thousands separators, units ("12,5 km"), sign, both locales.
- Same exported name, different results: `parseGermanDecimal("1.234,5")` → format.ts: `parseFloat("1.234.5")` = **1.234**; parse-german-decimal.ts: **1234.5** (factor 1000). `"12,5 km"` → format.ts: parseFloat("12.5 km") = 12.5 (works only because parseFloat stops at ' '), but `"km 12,5"` or NBSP variants diverge.
- Consumers split across the two:
  - `client/src/features/appointments/components/travel-documentation.tsx:8` and `client/src/pages/document-appointment.tsx:21` import from `@shared/utils/format` (weak) — these feed the km/hours that get **booked** on documentation.
  - `server/services/appointment-import.ts:13` imports from `@shared/utils/parse-german-decimal` (robust) — the Excel import path.
  → The same string "1.234,5" produces different km depending on whether it enters via the doc UI or via import: a display-vs-booking / path-vs-path drift of exactly the class the equality tests exist for.
- Remediation: delete the format.ts variant, re-export the Task-#819 SSoT from format.ts (like the `formatEuroDE` shim), add an architecture test forbidding a second `function parseGermanDecimal` outside `shared/utils/parse-german-decimal.ts` (see also Finding 4: `server/services/qonto-csv-parser.ts:10` defines a third one).

## Finding 4 (HIGH) — Third and fourth euro-string→cents parsers in payment ingestion (Avis/Qonto)

- Duplicates:
  - `server/services/avis-parser.ts:51-56` — `parseEuroCents`: `value.trim().replace(/\s/g,"").replace(/€/g,"").replace(/\./g,"").replace(",", ".")` → `Math.round(num * 100)`.
  - `server/services/qonto-csv-parser.ts:10-15` — a private `parseGermanDecimal` (name-shadows the shared SSoT): strips all dots, comma→dot; used at `:142-143` as `Math.round(Math.abs(gesamtBetrag) * 100)` → `amountCents` (:165).
- Canonical: `shared/utils/money.ts:71-96` (`parseEuroDE`), `shared/utils/parse-german-decimal.ts:33-96`.
- Divergence: both strip **all** dots up front, so an English-format amount `"125.50"` becomes `"12550"` → 12550 € → **1 255 000 cents** (100× error class) where `parseEuroDE` yields 12550 cents. `"1,234.56"` (English thousands) → `"1,23456"` → 1.23 €. These parse remittance/payment amounts that drive invoice matching and payment classification (`classifyPaymentDifference`).
- Remediation: replace both with `parseEuroDE` (or the Task-#819 parser + one `Math.round(x*100)` inside money.ts). Extend the no-money-arithmetic guard: pattern 3 currently only matches `euro`-named variables (`gesamtBetrag` evades it).

## Finding 5 (HIGH) — Business dates derived via UTC `toISOString().slice(0, 10)` instead of local `formatDateISO`/`todayISO`/`parseTimestamp`

- Duplicates (all in-scope, non-test):
  - `server/routes/admin/qonto.ts:472-473` — `zahlungsDatum = emitted.toISOString().slice(0, 10)` — **persisted** payment date used in the matching transaction.
  - `server/routes/admin/mitarbeiterabrechnung.ts:260, 283, 330` — payroll appointment/time-entry/absence dates: `new Date(r.date).toISOString().slice(0, 10)`.
  - `server/routes/admin/lexware-export.ts:131` — same pattern for the wage export.
  - `server/storage/billing/pipeline-reader.ts:208` — aging anchor: `new Date(inv.sentAt).toISOString().slice(0, 10)`; the client computes the SAME anchor differently (`client/src/features/billing/utils.ts:71-76`: `inv.sentAt.slice(0, 10)`) — two mechanisms for one business question.
  - `client/src/pages/appointment-detail.tsx:342` — "today" via `new Date().toISOString().slice(0, 10)` for the past-scheduled diagnosis gate.
  - `server/services/qonto-backfill-runner.ts:105`.
  - (UTC-internally-consistent, lower risk: `server/storage/statistics/common.ts:46-52`, `server/storage/statistics/process-health.ts:63`.)
- Canonical: `shared/utils/datetime.ts:55-67` (`formatDateISO`, `todayISO` — local), `:398-410` (`parseTimestamp` — the documented only-place for `new Date(string)` on timestamps). Header KONVENTIONEN §3 explicitly forbids ISO-timestamp round-trips for local dates.
- Divergence: with `TZ=Europe/Berlin`, a PG `date` parsed by node-postgres is local midnight; `toISOString()` shifts it to 22:00/23:00Z of the **previous day** → payroll/export dates off by one on every row. For `new Date()`-today (appointment-detail) and timestamptz events (qonto `emittedAt`), the UTC date differs from the German business date between 00:00 and 01:00/02:00 local. Whether this bites depends on server TZ — which is exactly the nondeterminism the datetime conventions ban.
- Remediation: `typeof v === "string" ? v : formatDateISO(v)` for date columns; `formatDateISO(parseTimestamp(ts))` for timestamps; `todayISO()` for today. Add an ast-grep guard for `toISOString().slice(0, 10)` / `.split("T")[0]` outside `shared/utils/` and `tests/`.

## Finding 6 (MEDIUM) — `formatKm` exists three times with different precision (regression of the exact bug Task #616 fixed)

- Canonical: `shared/utils/format.ts:40-43` — `formatKm`: quantizeKm + **2** decimals, comma ("7,30"). Doc comment: "km wird projektweit mit 2 NK angezeigt … Vorher lieferte formatKm 1 NK … Anzeige ≠ Buchung".
- Duplicates:
  - `client/src/features/billing/utils.ts:25-27` — a second exported `formatKm`: `toLocaleString("de-DE", { maximumFractionDigits: 1 })` → **1** decimal.
  - `client/src/pages/admin/mitarbeiterabrechnung.tsx:207-209` — `fmtKm`: min/max **1** decimal (payroll page).
  - `client/src/pages/admin/statistics/v2/economics-block.tsx:162, 170` — inline `toLocaleString("de-DE", { maximumFractionDigits: 2 })` without quantizeKm.
- Divergence: 7.297 km renders "7,30" (canonical), "7,3" (billing utils, payroll) and "7,3"/"7,3" unquantized in economics — the same km value shown differently across Budget-Ledger, Billing-Cockpit and Mitarbeiterabrechnung; identical name `formatKm` invites the wrong import.
- Remediation: delete both local variants, import `formatKm` from `@shared/utils/format` (append " km" at callsite or add an option). Architecture test: forbid `function formatKm` outside shared/utils.

## Finding 7 (MEDIUM) — `todayISO`/`formatDateISO`/`parseLocalDate` hand-rolled at ~20 sites, including twice inside `shared/domain/appointments.ts`

- Canonical: `shared/utils/datetime.ts:46-67`.
- Duplicates (all verified as `${getFullYear()}-${pad(getMonth()+1)}-${pad(getDate())}` or split-based clones):
  - Inside shared itself: `shared/domain/appointments.ts:270-275` (`formatLocalIsoDate`), `:522-525` (`parseSeriesDate` = clone of `parseLocalDate`), `:527-532` (`formatSeriesDate` — a second clone in the same file); `shared/utils/holidays.ts:24-28` (`addDaysToDate`) + `:30-35` (`formatDate`).
  - Server: `server/routes/standard-prices.ts:44`, `server/routes/budget.ts:105`, `server/routes/appointment-series.ts:113`, `server/routes/role-wage-rates.ts:41`, `server/routes/customers/service-prices.ts:14, 446, 575, 619`, `server/storage/pricing/price-for.ts:36`, `server/storage/statistics/alerts.ts:24`, `server/storage/tasks.ts:353`, `server/startup/populate-prices-from-legacy.ts:102`, `server/routes/admin/test-cleanup.ts:109`, `server/lib/team-workload.ts:47-52`.
  - Client: `client/src/features/billing/utils.ts:45-51` (`todayIso` — byte-for-byte clone of `todayISO`), `client/src/features/customers/components/admin/customer-pricing-section.tsx:81`, `client/src/features/services/components/service-economics-section.tsx:152`, `client/src/features/admin/components/admin-cockpit.tsx:41`, `client/src/features/appointments/components/customer-appointments-tab.tsx:17`, `client/src/features/time-tracking/components/month-closing-section.tsx:15`, `client/src/features/time-tracking/components/time-entry-dialog.tsx:320`, `client/src/components/budget/BudgetTypeSettings.tsx:96`, `client/src/components/charts/sparkline.tsx:22`.
- Divergence: today all clones compute the same string; the hazard is drift-by-edit (any one site switching to `toISOString()` — see Finding 5 — silently changes TZ semantics) and the sheer number of grep-invisible copies. The 5 `service-prices.ts`/`price-for.ts` copies are the effective-date logic of the **pricing** SSoT.
- Remediation: mechanical replace with `formatDateISO`/`parseLocalDate`/`todayISO` imports; ast-grep guard for the template-literal pattern `${...getFullYear()}-${...}` outside `shared/utils/datetime.ts`.

## Finding 8 (MEDIUM) — `lastDayOfMonth` re-implemented in the §45a consumption engine and appointments route while a sibling module uses the canonical helper

- Canonical: `shared/utils/datetime.ts:370-373` (`lastDayOfMonth(year, month)`); used correctly by `server/storage/budget/reservation-storage.ts:272`.
- Duplicates:
  - `server/storage/budget/consumption-engine.ts:245-248` — month window for §45a availability: manual `new Date(y, m+1, 0).getDate()` + string building (booking-path code).
  - `server/routes/appointments.ts:303-306` — `currentMonthEnd`/`nextMonthEnd` with unpadded day (`getDate()` interpolated raw — works only because day ≥ 28).
- Divergence: none numerically today; hazard is that the budget **booking** window (consumption-engine) and the budget **reservation** window (reservation-storage) are built by two different mechanisms — a mutation to one is invisible to the other, precisely the display-vs-booking drift class the equality tests target.
- Remediation: import `lastDayOfMonth` in both sites.

## Finding 9 (MEDIUM) — Euro display via `.toFixed(2)` instead of `formatEuroDE` (English decimal point shown in German UI; two sites currently fail the checked-in money guard)

- Canonical: `shared/utils/money.ts:44-56` (`formatEuroDE`).
- Duplicates:
  - `client/src/features/customers/components/wizard/budgets-step-validation.ts:50` — `${centsToEuroNumber(maxCarryoverCents).toFixed(2)} €` in a user-facing error.
  - `client/src/features/customers/components/wizard/budgets-contract-step.tsx:49, 54, 57, 244, 472` — cap messages and price display ("Maximal 3539.00 €/Jahr…").
  - `client/src/features/billing/hooks/use-billing-mutations.ts:585` — toast: `(data.overflowCents / 100).toFixed(2)` — **flagged by the money guard's own regex when replayed against the tree** (gate red).
  - `client/src/pages/admin/settings/letterxpress-settings.tsx:72, 180` — `balance.toFixed(2)} €`.
  - `server/routes/budget.ts:1405` — `euroAmount: centsToEuroNumber(...).toFixed(2)` in an admin diagnostic payload.
  - (Deliberate, allowlisted, correctly documented: `server/lib/zugferd.ts:78-79`.)
- Divergence: "125.50 €" vs. canonical "125,50 €"; no thousands separators; sign handling ad hoc. Cosmetic per site, but it is the exact drift class Task #441 centralized, and the ALL-CAPS constants (`BUDGET_45B_MAX_MONTHLY_CENTS / 100`, budgets-contract-step.tsx:48, 56) evade the guard because `[Cc]ents` does not match `CENTS`.
- Remediation: `formatEuroDE(cents)` everywhere; make guard pattern 2 case-insensitive (`/\b\w*[Cc]ENTS?\b/i`-style) and add `\.toFixed\(2\)\s*\}?\s*€`.

## Finding 10 (MEDIUM) — Inline `Number(x.replace(",", "."))` German-decimal parsing in payroll account editing

- Duplicates: `client/src/pages/admin/mitarbeiterabrechnung.tsx:1141` (`anfangsbestand`) and `:1153` (`bezahlt`) — hours-account opening balance and paid-hours input.
- Canonical: `shared/utils/parse-german-decimal.ts:33-96`.
- Divergence: `"1.234,5"` → `Number("1.234.5")` = NaN → save blocked with "Bitte eine Zahl eingeben" (fail-loud, but rejects valid German input the SSoT accepts); `"12,5 h"` → NaN (SSoT strips units). Inconsistent input UX across pages that already use the SSoT.
- Remediation: import the Task-#819 `parseGermanDecimal`; the mutation payload stays a plain number.

## Finding 11 (LOW) — `isWeekend` / Monday-week-start logic re-implemented

- Duplicates:
  - `server/storage/time-tracking/payroll-hours.ts:134-135` — `const dayOfWeek = date.getDay(); if (dayOfWeek === 0 || dayOfWeek === 6) continue;` (holiday-hours calc; `parseLocalDate` already imported in that file).
  - `shared/domain/appointments.ts:556, 563` — `(weekStart.getDay() + 6) % 7` Monday alignment, duplicating `startOfWeekMonday` (`shared/utils/datetime.ts:171-176`); `:321-323` `startOfLocalDay` duplicates the first line of the same helper.
  - (`shared/utils/month-close-cutoff.ts:24-28` has a private UTC `isWeekendOrHoliday` — internal to a canonical utility, deliberately UTC; acceptable but worth a comment.)
- Canonical: `shared/utils/datetime.ts:92-95` (`isWeekend`), `:171-176` (`startOfWeekMonday`).
- Divergence: none today (same math); pure DRY/maintenance hazard. Note: payroll-hours skips weekend holidays but (correctly, per `getHolidays`) has no Bundesland parameter — any future divergence between "weekend" definitions would silently split payroll from vacation logic.
- Remediation: use `isWeekend(holiday.date)` and `startOfWeekMonday`.

## Finding 12 (LOW) — German month-name arrays copied 10+ times instead of the Task #928 de-locale SSoT

- Canonical: `shared/utils/datetime.ts:162-165` (`formatGermanDate(date, "MMMM yyyy")` — comment: "Bündelt die date-fns-Locale-Nutzung an EINER Stelle (Task #928)").
- Duplicates (hand-maintained `["Januar", …]` arrays): `client/src/components/month-close-banner.tsx:18`, `client/src/components/charts/sparkline.tsx:16`, `client/src/features/time-tracking/constants.ts:30`, `client/src/features/time-tracking/lib/month-closing-message.ts:4`, `client/src/features/admin/components/admin-cockpit.tsx:24`, `client/src/features/services/components/service-economics-section.tsx:146`, `client/src/features/customers/components/wizard/budgets-contract-step.tsx:100-103`, `client/src/features/billing/constants.ts:2`, `client/src/pages/admin/mitarbeiterabrechnung.tsx:199-202`, plus `server/lib/pdf-generator.ts` (`MONTH_NAMES` used at :351) and the label array used by `server/routes/appointments.ts:290`.
- Divergence: none observable (month names are stable), but each copy is a translation/typo hazard and every new month-picker re-invents `YYYY-MM` building (overlaps Finding 7 sites).
- Remediation: one shared `MONTH_NAMES_DE` (or `formatGermanDate(d, "MMMM")`) exported next to `formatGermanDate`.

---

## Clean areas (checked, no re-implementations found)

- **Phone** (`shared/utils/phone.ts`): `server/services/whatsapp-service.ts:39` delegates to `normalizePhone`; `server/lib/pdf-generator.ts:4` imports `formatPhoneForDisplay`. No hand-rolled `+49`/E.164 regexes outside phone.ts (only UI placeholders).
- **Holidays** (`shared/utils/holidays.ts`): no second Easter/holiday-list computation anywhere (grep `easterSunday|Karfreitag|Ostermontag`).
- **Zod German errors** (`zod-german.ts`): single `setErrorMap` call; per-schema `errorMap` options in `server/routes/admin/qonto.ts:1218` / `audit.ts:15` are legitimate field-level messages, not a parallel map.
- **Month-close cutoff**: `computeMonthCloseCutoff` has no competitor implementation.

## Observed guard gaps (why these slipped past 11 CI gates)

1. `no-money-arithmetic-outside-helper.test.ts`: pattern 2 misses ALL-CAPS `…_CENTS / 100`; pattern 3 only matches variables named `*euro*` (misses `amount`, `uebertrag`, `gesamtBetrag`); replaying its regexes today flags `reduce-45b-dialog.tsx:46` and `use-billing-mutations.ts:585` — verify whether the gate is actually green in CI (could not run vitest in this sandbox; standalone replication of the scan is in this report's method note).
2. `no-raw-service-vat-rate.test.ts`: `(service.vatRate || 0) / 100` evades both patterns via the `||` fallback.
3. No guard exists for: `toISOString().slice(0,10)` / `.split("T")[0]` outside shared+tests; hand-rolled `${getFullYear()}-…` date building; second definitions of `formatKm` / `parseGermanDecimal` / `todayIso`.

## Not swept

- SQL-level date/money logic inside raw `sql` template literals (only cursory), DB triggers/migrations, `scripts/` + `server/scripts/` (guard-allowlisted CLI tools), `e2e/`, `tests/`, `client/src/components/ui/**`, `server/replit_integrations/**`, and the budget-availability/pricing reader duplication question (separate audit scope).
