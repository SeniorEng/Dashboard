# Audit: Parallel Business Logic / SSoT Violations — CareConnect

Date: 2026-07-22
Scope: `shared/`, `server/` (excluding tests and `server/replit_integrations/**`), sampled `server/routes/` and `server/storage/`.
Method: (1) name-clustered function inventory (`calculate*|compute*|derive*|resolve*|determine*|is*Allowed|is*Eligible|get*Status|format*|build*`) with duplicate-name detection; (2) Zod schema duplication sweep; (3) distinctive-literal grep for business constants (status enums, entry-type lists, euro amounts, PLZ regex, price-resolution SQL); (4) manual read-and-confirm of every candidate pair before reporting.

Explicitly NOT re-audited (team's guarded SSoTs): budget-availability reader, `priceFor`/`wageFor` TS resolution, appointment-signed predicate, month-close readiness. However, findings 1–2 show *unguarded SQL mirrors* of two of these drifting.

---

## Finding 1 (HIGH) — Phantom appointment status `'documented'`: ~50 hand-rolled SQL status sets in statistics + team-workload, parallel to the status SSoT

**The SSoT:** `shared/domain/appointments.ts:14` defines `AppointmentStatus = "scheduled" | "documenting" | "completed" | "cancelled" | "expired_unsigned" | "customer_no_show"`. `PERSISTED_APPOINTMENT_STATUSES` (`shared/domain/appointments.ts:30-36`) and `FINAL_APPOINTMENT_STATUSES` (`:53-57`) are the declared single lists. The SQL mirror is `server/lib/appointment-signed.ts` (`documentedSqlRaw` = `status = 'completed'`, line 93-96).

**The parallel logic:** the entire statistics storage layer plus `server/lib/team-workload.ts` filter on `a.status IN ('completed','documented')` — but **`'documented'` is not a persisted status**. These filters are effectively `status = 'completed'`, written as a two-value set that only *looks* like it covers documentation. Worse, "planned" is hand-rolled as `status IN ('scheduled','completed','documented')`, which **excludes `'documenting'`** — an appointment mid-documentation silently drops out of the planned funnel, minutes-by-service-type, active-customer counts, etc. Meanwhile other modules answer the same "did work happen / is it open" question with *different* hand-rolled sets:

- `('completed','documented')` (phantom): `server/storage/statistics/cockpit.ts:34,35,75,96,97,98,124,140,147,153`; `server/storage/statistics/economics.ts:72,161,215,239,240,241`; `server/storage/statistics/revenue.ts:65,66,108,109,164,165,208,209,241,242,271,348,349,361,367,394,410,418,535`; `server/storage/statistics/performance.ts:17,41,80,102,137,164,194,230`; `server/storage/statistics/customers.ts:11,23,32,109,111,123,129,213`; `server/storage/statistics/alerts.ts:80`; `server/lib/team-workload.ts:182,335`
- `('completed','documenting')` (worked time): `server/services/auto-breaks.ts:71,220`; `server/storage/time-tracking/overview.ts:157,297`
- `status = 'completed'` (SSoT): `server/lib/appointment-signed.ts:58,95` — used by billing/payroll (`server/storage/billing/economics-reader.ts:211` etc.)
- `scheduled/documenting = open` (SSoT-conform): `shared/domain/billing-pipeline.ts:131`

**Divergence produced:** For any appointment sitting in `documenting`, the statistics cockpit/revenue/economics pages count zero planned revenue and zero minutes, while the billing pipeline counts it as "Offen" and time-tracking/payroll counts its minutes as worked. Statistics vs. billing "Wirtschaftlicher Überblick" show different numbers for the same month (see Finding 3).

**Suggested SSoT:** derive all SQL status sets from `shared/domain/appointments.ts` constants via helpers in `server/lib/appointment-signed.ts` (add e.g. `plannedStatusesSqlRaw`, `workedStatusesSqlRaw`); forbid the literal `'documented'` in SQL via an ast-grep/architecture test.

---

## Finding 2 (HIGH) — Customer-price resolution re-implemented as a copy-pasted SQL subquery at 13 sites, semantically diverging from the `priceFor` SSoT

**The SSoT:** `shared/domain/pricing/price-for.ts` (`resolvePriceFor`) loaded via `server/storage/pricing/price-for.ts:45-149`. Resolution order: customer-scope price rows (**all origins**, `price-for.ts:88-94`) → **standard-scope time-versioned rows** (`:109-131`) → catalog `default_price_cents`. The wage side has a proper SQL mirror: `server/storage/pricing/wage-for-sql.ts` (`resolvedWageCentsSql`).

**The parallel logic:** the statistics/billing readers inline this correlated subquery (verbatim copy-paste):

```sql
COALESCE((SELECT csp.cents FROM prices csp
  WHERE csp.scope = 'customer' AND csp.origin = 'customer_service_prices' ...
  ORDER BY csp.valid_from DESC LIMIT 1), s.default_price_cents)
```

Sites: `server/storage/statistics/revenue.ts:21-28, 90-97, 330, 378`; `server/storage/statistics/performance.ts:30, 91, 183, 214`; `server/storage/statistics/cockpit.ts:17-24, 112-119`; `server/storage/statistics/economics.ts:203-210`; `server/storage/billing/economics-reader.ts:242-249`; `server/storage/billing/pipeline-reader.ts:112`.

**Divergence produced:** the SQL copies (a) only honor customer prices with `origin='customer_service_prices'` — customer prices originating from `customer_contract_rates` are ignored; (b) skip the `scope='standard'` time-versioned price entirely, falling straight to the static catalog column. Whenever a standard price row differs from `services.default_price_cents`, or a customer has a contract-rate-origin price, **statistics revenue ≠ invoiced revenue** computed through the SSoT.

**Suggested SSoT:** create `server/storage/pricing/price-for-sql.ts` (`resolvedPriceCentsSql(...)`) mirroring `wage-for-sql.ts`, replace all 13 fragments, and guard with an ast-grep test banning `origin = 'customer_service_prices'` outside `pricing/`.

---

## Finding 3 (HIGH) — Two parallel "Wirtschaftlicher Überblick" readers with byte-identical duplicated helpers and diverging appointment gates

`server/storage/statistics/economics.ts` (`getEconomics`) and `server/storage/billing/economics-reader.ts` (`readBillingEconomics`) both aggregate HW/AB minutes, role-based costs, km and overhead for a month and feed `buildEconomics`.

Duplications:
- `resolveRates()` **byte-identical**: `server/storage/statistics/economics.ts:18-41` vs `server/storage/billing/economics-reader.ts:75-98`.
- `NON_BILLABLE_TYPES` constant duplicated: `statistics/economics.ts:16` vs `economics-reader.ts:50` (the latter even comments "SSoT-Spiegel aus economics.ts" — an admitted mirror), plus the same list inlined as SQL literals at `statistics/economics.ts:120,322` and `economics-reader.ts:312`.
- Near-identical non-billable-cost and km-cost SQL blocks (`statistics/economics.ts:109-140,151-194` vs `economics-reader.ts:300-329`).

Divergences (same month, different numbers):
- Appointment gate: statistics uses phantom `status IN ('completed','documented')` (`statistics/economics.ts:72,161,215`); billing reader uses the SSoT `documentedSqlRaw('a')` (`economics-reader.ts:211,255,279,348`). Identical today only by accident (Finding 1).
- Category attribution: statistics collapses each appointment to ONE category via `DISTINCT ON (a.id)` (`statistics/economics.ts:58-77`); the billing reader counts per service row (Task #1752, `economics-reader.ts:201-232`) — a mixed HW+AB appointment is attributed differently in the two views.
- Erstberatung: overhead channel in billing reader (`economics-reader.ts:61-64,339-367`), productive category in statistics (`statistics/economics.ts:65`).

**Suggested SSoT:** one economics reader module (or shared SQL fragment library) under `server/storage/economics/`; at minimum move `resolveRates` and `NON_BILLABLE_TYPES` into one file imported by both, and align the documented-gate.

---

## Finding 4 (HIGH) — Revenue-stage funnel (Geplant/Dokumentiert/Nachgewiesen/Berechnet) implemented 3× with diverging stage definitions

- `server/storage/statistics/revenue.ts:60-82` (`computeStages`) + `:84-141` (`stageSparklines`)
- `server/storage/statistics/cockpit.ts:6-55` (`computeRevenueStages`) + `:106-174` (`sparklines`) — near-verbatim copy of revenue.ts
- `server/storage/statistics/economics.ts:225-266` (`stageHours`) — same funnel in minutes

Divergences:
- "Proven" stage: economics requires `status IN ('completed','documented') AND id IN (signed service records)` (`economics.ts:241`), while cockpit/revenue count **any** appointment linked to a completed service record regardless of status (`cockpit.ts:36-40`, `revenue.ts:67-71`) — a cancelled appointment attached to a completed LN counts as "proven" revenue in the cockpit but not as "proven" minutes in economics.
- "Invoiced" stage: cockpit/revenue sum `invoice_line_items.total_cents` (`cockpit.ts:44-50`, `revenue.ts:74-78`); economics sums `appointments.duration_promised` of line-item appointments (`economics.ts:248-257`). Same label, different population (km/flat line items included in one, appointment-less line items excluded from the other).

**Suggested SSoT:** one `stage-funnel.ts` in `server/storage/statistics/` exposing the stage CASE fragments; funnel stage membership should be a single SQL-fragment builder shared by cockpit, revenue, sparklines and economics.

---

## Finding 5 (MEDIUM) — Birthday age & occurrence logic duplicated with real divergence

- `server/routes/birthdays.ts:114-126` (`calculateAge`), `:128-133` (`calculateUpcomingAge`, rule `daysUntil <= 0 ? age : age + 1`), `:73-87` + `:94-112` (`getBirthdayOccurrenceInYear` with explicit **Feb-29 leap-year handling**).
- `server/services/birthday-notification-checker.ts:10-20` re-implements `calculateUpcomingAge` inline (rule `daysUntil === 0 ? age : age + 1` — differs for overdue birthdays) and `:39-41` / `:70-72` re-compute "birthday occurrence this year" as `new Date(y, month, date)` **without Feb-29 handling** (Feb 29 rolls to Mar 1 in non-leap years, so the task's `birthdayYear` and dedup key diverge from the list view). Note the checker *does* import `calculateDaysUntilBirthday` from the route file — the SSoT exists one import away.

**Suggested SSoT:** move `calculateAge`, `calculateUpcomingAge`, `getBirthdayOccurrenceInYear`, `calculateDaysUntilBirthday` to `shared/domain/birthdays.ts`; both route and checker import from there (also fixes the service→route import inversion).

---

## Finding 6 (MEDIUM) — "Which entry types count as work / overhead" lists defined in 7+ places

SSoT candidate exists: `shared/domain/time-entries.ts:156` (`WORK_ENTRY_TYPES = ["bueroarbeit","vertrieb","sonstiges"]`, with `isWorkEntryType`). Parallel definitions:

- `server/storage/time-tracking/payroll-hours.ts:34` — `PAID_MANUAL_ENTRY_TYPES = new Set(["bueroarbeit","vertrieb","sonstiges"])` (payroll: money-relevant)
- `server/lib/team-workload.ts:196` — SQL literal `entry_type IN ('bueroarbeit','vertrieb','sonstiges')`
- `server/storage/statistics/performance.ts:19` — SQL literal, same 3
- `server/storage/statistics/economics.ts:16` + `server/storage/billing/economics-reader.ts:50` — `NON_BILLABLE_TYPES` (the 3 + `krankheit`,`urlaub`), plus SQL literals `statistics/economics.ts:120,322`, `economics-reader.ts:312`

Adding a new manual entry type (e.g. "fortbildung") requires 7+ edits; payroll, workload, and economics silently disagree if one is missed.

**Suggested SSoT:** extend `shared/domain/time-entries.ts` with `NON_BILLABLE_ENTRY_TYPES` derived from `WORK_ENTRY_TYPES` + absence types; generate SQL `IN (...)` fragments from the constant.

---

## Finding 7 (MEDIUM) — Prospect update validation mirrored by hand between shared schema and employee route

`shared/schema/prospects.ts:167-` (`updateProspectSchema`, whitelist derived from `insertProspectSchema.shape`) vs `server/routes/prospects.ts:54-64` (`prospectContactUpdateSchema` — the comment admits "Wir spiegeln hier bewusst den Feldumfang des Admin-Endpunkts"). Confirmed drift already exists: the route copy validates `pflegegrad` with `.int()` (`routes/prospects.ts:63`), the shared schema does not (`shared/schema/prospects.ts:137`) — admin endpoint accepts 2.5, employee endpoint rejects it. Additionally `inlineProspectSchema` (`routes/prospects.ts:36-47`) accepts `plz` with **no format validation** while both others enforce 5 digits.

**Suggested SSoT:** export the contact-field subset from `shared/schema/prospects.ts` (e.g. `prospectContactFields`) and have both endpoints `.pick()` from it.

---

## Finding 8 (MEDIUM) — PLZ validation: canonical `plzSchema` exists but 8+ inline regex copies with 3 different error texts

SSoT: `shared/schema/common.ts:175-176` (`plzSchema`). Inline copies: `shared/schema/appointments.ts:223,250`; `shared/schema/insurance.ts:85`; `shared/schema/prospects.ts:135`; `server/routes/admin/customers.ts:279,824` ("Ungültige PLZ (5 Stellen erwartet)"); `server/routes/customers.ts:98` ("PLZ muss 5-stellig sein"); `server/routes/prospects.ts:61`. Same business rule, three German error messages, and one endpoint (Finding 7) with no rule at all.

**Suggested SSoT:** reuse `plzSchema` (compose `.optional().or(z.literal(""))` variants next to it in `common.ts`); ast-grep guard banning `\d{5}` regex in zod outside `shared/schema/common.ts`.

---

## Finding 9 (MEDIUM) — Contract create/update schemas re-declared inline with hardcoded enums

SSoT: `shared/schema/contracts.ts:54-68` (`CONTRACT_PERIOD_TYPES`, `CONTRACT_STATUS`, `insertCustomerContractSchema`). Parallel: `server/routes/admin/customers/contracts.ts:37-45` (`updateContractSchema`) and `:47-53` (`createContractSchema`) hardcode `z.enum(["week","month","year"])` / `z.enum(["active","paused","terminated"])` instead of the shared constants; field rules drift (`hoursPerPeriod` `.int()` in route vs plain `.min(0)` in shared; `notes` max-500 exists only in shared). A new period type or status added to the shared constants would not propagate to the admin endpoints.

**Suggested SSoT:** derive route schemas from `insertCustomerContractSchema.partial().pick(...)` in `shared/schema/contracts.ts`.

---

## Finding 10 (MEDIUM) — Customer postal-address block built by two functions; a third display formatter overlaps

- Declared SSoT: `server/lib/customer-address-format.ts:10-20` (`formatCustomerMasterAddress`, Task #1030, "strasse nr\nplz stadt").
- Re-implementation: `server/storage/budget-recipients.ts:47-57` (`buildCustomerAddress`) — same output built independently for invoice recipients; behavior currently identical, but a fix in one (e.g. handling `nr` without `strasse`) will not reach the other. `buildInsuranceAddress` (`budget-recipients.ts:59-76`) is a third address assembler.
- Overlapping display variant: `shared/utils/format.ts:101-119` (`formatAddress`, comma-joined single line with fallback text) — intentionally different presentation but same field logic.

**Suggested SSoT:** move `formatCustomerMasterAddress` to `shared/utils/format.ts` (or `shared/domain/address.ts`) with `multiline`/`inline` variants; `budget-recipients.ts` imports it.

---

## Finding 11 (LOW) — "Vorname Nachname" full-name assembly scattered with divergent fallbacks

- `server/storage/budget-recipients.ts:38-45` (`buildCustomerName`: fallback `name` → `"Unbekannt"`)
- `server/routes/billing.ts:1864` (`[cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name`)
- `server/services/invoice-calc.ts:287` (`vorname && nachname ? "v n" : ...`)
- `server/services/budget-renewal-checker.ts:52` (`` `${vorname} ${nachname}`.trim() `` — no `name` fallback)
- `server/services/auth.ts:98`

Same customer can render as "Unbekannt", "", or the legacy `name` depending on surface. A last-first SSoT already exists for the other direction (`shared/utils/format.ts:87` `formatCustomerNameLastFirst`) — the first-last variant should live beside it.

---

## Finding 12 (LOW) — Copy-pasted helpers in scripts and within `routes/billing.ts`

- `resolveActorUserId()` — identical body in 3 scripts: `server/scripts/apply-vacation-policy-2026.ts:84`, `server/scripts/cleanup-selbstzahler-statutory-budgets.ts:326`, `server/scripts/clamp-over-limit-budget-type-settings.ts:194`.
- `resolveStoredObject()` — identical mod one comment: `server/scripts/regenerate-clobbered-invoice-pdfs.ts:141` vs `server/scripts/restore-legacy-invoice-pdfs-from-backup.ts:142`.
- Email+logo delivery preamble duplicated inside one file: `server/routes/billing.ts:917-925` vs `:1855-1862` (dynamic import of email-service, `logoAttachment`/`resolvedLogo`/`logoAttachments` triplet) — invoice-delivery boilerplate that belongs in `server/services/invoice-delivery.ts`.

Low business risk (scripts/one file), but classic seeds for future drift.

---

## Areas swept and found CLEAN (for the remediation backlog's avoidance list)

- **Vacation**: `server/storage/time-tracking/vacation.ts` correctly delegates to `shared/domain/vacation.ts` (entitlement, carryover, history). No parallel math found.
- **Auto-breaks / ArbZG**: `server/services/auto-breaks.ts` delegates to `calculateRequiredBreak` / `isWorkEntryType` / `ARBZG_MAX_DAILY_MINUTES` in shared domain.
- **Money formatting**: `shared/utils/format.ts:23` `formatCurrency` is an explicit shim over `formatEuroDE` (Task #441) — intentional, guarded.
- **Budget euro constants**: 131 € / §45a table / §39-42a amounts exist once in `shared/domain/budgets.ts:10,36,48`.
- **Service catalog & VAT rates**: single source `shared/config/services.ts`.
- **NOT swept** (time-boxed): client/src (except noting ~7 local `formatDate` copies), WhatsApp/Twilio services, Qonto domain internals, document-trigger engine, e2e helpers.

## Remediation priorities

1. Findings 1+2 first — they are silent numeric drift in money/KPI surfaces and each has an existing SSoT to converge on; both are mechanically guardable (ast-grep ban on `'documented'` status literal and on the `customer_service_prices` SQL fragment outside `pricing/`).
2. Finding 3/4 second — consolidate the statistics/billing economics + funnel readers on the fragments created in step 1.
3. Findings 5-10 as normal refactor tickets with a "replace, don't add" checklist; add the two new shared modules (`shared/domain/birthdays.ts`, address/name helpers) to knip's entry graph so dead copies surface.
