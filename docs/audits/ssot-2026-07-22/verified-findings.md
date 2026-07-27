# SSoT-/Redundanz-Audit — Verifizierte Findings (2026-07-22)

Erzeugt durch den 41-Agenten-Audit-Lauf (Branch `claude/ssot-redundancy-detection-grrpph`).
Jedes Finding wurde von einem unabhängigen, skeptischen Verifikations-Agenten am echten Code geprüft.
Verdikte: **CONFIRMED** = echte SSoT-Verletzung, fixen · **INTENTIONAL** = bewusste/inzidentelle Duplizierung, dokumentieren statt fixen · **FALSE_POSITIVE** = Behauptung hielt der Prüfung nicht stand.

Rohberichte der Auditoren (inkl. unverifizierter Kandidaten Nr. 11-12 je Kategorie): siehe `raw/` in diesem Ordner. jscpd-Rohstatistik: `raw/jscpd-analysis.md`.


## A. Re-Implementierungen von shared/utils-Helfern

### util-reimpl-1: Raw service.vatRate gross-price math in customer wizard (Task #1659 SSoT bypass, guard evaded via `|| 0`)

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/customers/components/wizard/budgets-contract-step.tsx:466`
- `client/src/features/customers/components/wizard/budgets-contract-step.tsx:472`
- `shared/domain/invoice-vat.ts:52`
- `shared/domain/invoice-vat.ts:138`

**Evidenz (Auditor):** Wizard: `netPrice * (1 + (service.vatRate || 0) / 100)` then `displayPrice.toFixed(2)` — float euro math on the raw percent field, null swallowed as tax-free, English decimal point. Canonical `serviceVatRateBP()` throws on null and mandates integer-cents BP math (`grossUpUnitPriceCents`: `round(netCents*(10000+BP)/10000)`). Guard `tests/architecture/no-raw-service-vat-rate.test.ts` matches `\.vatRate\s*[*/]` — the `|| 0` between `.vatRate` and `/` evades it. Wizard-displayed gross price can differ from the invoice's gross price (rounding + null handling).

**Vorgeschlagene SSoT:** shared/domain/invoice-vat.ts (serviceVatRateBP + grossUpUnitPriceCents + resolveVatTreatment), formatted via shared/utils/money.ts formatEuroDE

**Verifikation:** Verified all cited sites: budgets-contract-step.tsx:466 computes gross via raw `netPrice * (1 + (service.vatRate || 0) / 100)` and line 472 formats with `.toFixed(2)` (English decimal point), while shared/domain/invoice-vat.ts:52 (serviceVatRateBP) throws on null and mandates percent-to-BP conversion — its docstring literally names `|| 0` as the forbidden pattern — and line 138 (grossUpUnitPriceCents) is the designated helper for exactly this informational gross unit-price display (used by pdf-generator.ts for the invoice's brutto column). I executed all three guard regexes from tests/architecture/no-raw-service-vat-rate.test.ts against line 466: none match, and the wizard file is not allowlisted, confirming the guard hole. showGrossPrices = !isPflegekasseCustomer(billingType) mirrors resolveVatTreatment's exempt/standard split (only 3 billing types exist), so this is the same business question, answered with divergent rounding (float+toFixed vs integer-cents round), divergent null policy (silent tax-free vs throw), and divergent locale formatting vs formatEuroDE. No comment or type suggests intentional duplication. Only caveat: severity is milder than "high" — display-only preview, schema is NOT NULL DEFAULT 19, so practical impact is the dot-decimal formatting plus rare 1-cent float drift.

**Fix-Skizze:** In budgets-contract-step.tsx, replace the inline math with the SSoT: derive treatment via resolveVatTreatment({ billingType: formData.billingType }) (or map showGrossPrices to "standard"/"exempt"), compute grossUpUnitPriceCents(service.defaultPriceCents, treatment), and render with formatEuroDE(cents, { withCurrency: false }) instead of toFixed(2), removing centsToEuroNumber/raw vatRate usage. Additionally tighten guard pattern A in no-raw-service-vat-rate.test.ts (e.g. /\.vatRate\b[^;\n]*[*/]/ or flag any `.vatRate` occurrence outside the allowlist) so the `|| 0` interposition can no longer evade it.

### util-reimpl-2: Euro-input parsing re-implemented with parseFloat/Number in booking forms — German comma silently truncated (parseEuroDE bypass)

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/components/budget/BudgetLedgerSection.tsx:1111`
- `client/src/features/billing/components/reduce-45b-dialog.tsx:41`
- `client/src/features/customers/hooks/use-customer-wizard.ts:352`
- `client/src/features/customers/hooks/use-customer-wizard.ts:362`
- `client/src/features/customers/components/wizard/budgets-step-validation.ts:49`
- `client/src/features/customers/components/wizard/budgets-step-validation.ts:71`
- `client/src/features/customers/components/wizard/budgets-contract-step.tsx:120`
- `shared/utils/money.ts:71`

**Evidenz (Auditor):** BudgetLedgerSection (manual budget adjustment, persisted ledger tx): `Math.round(parseFloat(amount || "0") * 100)` — parseFloat("125,50")=125 books 12500 cents, dropping the ,50. reduce-45b-dialog's local `parseEuroToCents` breaks on thousands ("1.234" -> 123 cents). Wizard create payload + step validation use the same `parseFloat(x)*100` on €-inputs. Canonical parseEuroDE handles "125,50", "1.234,56", "125.50". Money guard replayed against tree already flags reduce-45b-dialog.tsx:46; other sites evade because the variable isn't named `euro`.

**Vorgeschlagene SSoT:** shared/utils/money.ts parseEuroDE

**Verifikation:** All cited sites exist and re-implement euro-string-to-cents conversion that shared/utils/money.ts parseEuroDE (line 71, unit-tested, used by 5+ other components) canonically answers. The repo's own policy (money.ts header, guard test tests/architecture/no-money-arithmetic-outside-helper.test.ts) mandates parseEuroDE for exactly this pattern, and docs/budget-ssot-inventory.md:190,203 already lists the wizard sites as known deviations ("raw, NICHT über parseEuroDE") — no site uses the guard's money-arithmetic-allowed escape hatch, so the duplication is not intentional. Regex replay confirms the guard flags only reduce-45b-dialog.tsx:46 (variable named "euro", no allow-comment — the test would fail today) while the other sites evade via variable naming. One correction to the evidence: BudgetLedgerSection.tsx:1111 and the wizard fields all read type="number" inputs, whose values are browser-sanitized to dot-decimal or "", so the claimed comma-truncation ("125,50" → 12500 cents) cannot occur there — those are policy/latent-risk violations, not live bugs. The genuinely dangerous site is reduce-45b-dialog.tsx:41-47: a free-text input (inputMode="decimal", placeholder "z. B. 90,00") on an irreversible GoBD-relevant invoice reduction, where its local parseEuroToCents turns "1.234" into 123 cents (silent 10x error) and rejects valid "1.234,56"; parseEuroDE handles both, and the caller's paidCents > 0 check (line 65) preserves the local negative-rejection semantics.

**Fix-Skizze:** Replace the local parseEuroToCents in reduce-45b-dialog.tsx with parseEuroDE (the existing paidCents > 0 check keeps negative-rejection semantics), and swap the Math.round(parseFloat(x)*100) sites in BudgetLedgerSection.tsx:1111, use-customer-wizard.ts:352/357/362-364, budgets-step-validation.ts:49/71/94/104, and budgets-contract-step.tsx:120 to parseEuroDE(x) ?? 0 (preserving the current empty-string→0 behavior). Additionally strengthen the guard test's third pattern to also match Math.round(parseFloat(...) * 100) and generic Math.round(<ident> * 100) in money contexts so variable-naming evasion is closed.

### util-reimpl-3: Two diverging parseGermanDecimal implementations inside shared/utils — doc-UI path vs Excel-import path parse the same string differently

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `shared/utils/format.ts:51`
- `shared/utils/parse-german-decimal.ts:33`
- `client/src/features/appointments/components/travel-documentation.tsx:8`
- `client/src/pages/document-appointment.tsx:21`
- `server/services/appointment-import.ts:13`

**Evidenz (Auditor):** format.ts version is `String(value).trim().replace(",", ".")` + parseFloat (no thousands/units); parse-german-decimal.ts (documented Task #819 SSoT) handles both locales, thousands and units. Same exported name, different results: "1.234,5" -> 1.234 (format.ts) vs 1234.5 (SSoT) — factor 1000. Documentation UI imports the weak one (km/hours that get booked), the import path uses the strong one -> path-vs-path drift on identical input.

**Vorgeschlagene SSoT:** shared/utils/parse-german-decimal.ts (delete format.ts variant, re-export SSoT as shim like formatEuroDE)

**Verifikation:** Verified both implementations by reading them: shared/utils/format.ts:51 (first-comma replace + parseFloat, Task #616) and shared/utils/parse-german-decimal.ts:33 (dual-locale/thousands/units heuristic, Task #819) export the IDENTICAL name parseGermanDecimal from the same shared/utils directory and diverge exactly as claimed ("1.234,5" -> 1.234 vs 1234.5). All five cited call sites exist: UI km inputs (travel-documentation.tsx:103, document-appointment.tsx:407) use the weak one; appointment-import.ts:283-284 uses the SSoT. Neither delegates to the other. Both docstrings claim the same contract (German comma + English dot -> number, 0 on failure) — same business question, weaker implementation, not a different rounding/legal rule. Guard gap verified: unit tests cover only the SSoT, and the architecture test (tests/architecture/no-bare-number-in-import.test.ts) only bans Number(row[...]) — importing the weak variant into the import path would pass it while reintroducing the Task #819 GoBD bug. Caveat: the auditor's "high" severity is overstated — both UI sites are <Input type="number">, whose DOM value is sanitized to a dot-decimal float or "" (confirmed by e2e/smoke/edit-persistence.spec.ts:559), so "1.234,5"/"12,5 km" cannot practically reach the weak parser today; the violation is a real name-collision trap and drift hazard, not a currently reproducing booking bug. A third private copy in server/services/qonto-csv-parser.ts:10 (module-private, fixed-format CSV) confirms the drift pattern but is defensible.

**Fix-Skizze:** Delete the local implementation in shared/utils/format.ts and replace it with a re-export shim of the canonical function (export { parseGermanDecimal } from "./parse-german-decimal";) with a deprecation comment pointing to the SSoT module — the exact pattern format.ts already uses for formatCurrency -> formatEuroDE (Task #441). Signatures are compatible (SSoT takes unknown, a superset of string|number|null|undefined) and behavior is identical on the realistic UI input domain; optionally add a unit test asserting both import paths resolve to the same function.

### util-reimpl-4: Third and fourth euro-string→cents parsers in payment ingestion (Avis/Qonto) — 100x error class on dot-decimal input

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/services/avis-parser.ts:51`
- `server/services/qonto-csv-parser.ts:10`
- `server/services/qonto-csv-parser.ts:143`
- `shared/utils/money.ts:71`
- `shared/utils/parse-german-decimal.ts:33`

**Evidenz (Auditor):** avis-parser `parseEuroCents` and qonto-csv-parser's private `parseGermanDecimal` (name-shadows the shared SSoT) both strip ALL dots before comma→dot: "125.50" -> "12550" -> 1,255,000 cents where parseEuroDE yields 12550. "1,234.56" -> 1.23 €. These amounts drive invoice matching/classifyPaymentDifference. Guard evaded because variables are named `gesamtBetrag`/`value`, not `euro`.

**Vorgeschlagene SSoT:** shared/utils/money.ts parseEuroDE

**Verifikation:** All five cited sites exist and contain the claimed code. Both private parsers strip all dots before comma→dot ("125.50" → 12550 EUR, 100x), while shared parseEuroDE's own tests pin "125.50" → 12550 cents. Decisively, tests/unit/qonto/avis-parser-regression.test.ts contains a real IKK classic DAVASO fixture with dot-decimal amounts and freezes betragCents [1273200, ...] with an explicit comment that these are "×100 zu groß" and out-of-scope for that task — the 100x bug fires on real production data and is knowingly deferred, not intentional. The parsed cents flow into classifyPaymentDifference (shared/domain/qonto/payment-difference.ts), the declared payment-matching SSoT. The architecture guard (no-money-arithmetic-outside-helper.test.ts:56) is evaded exactly as claimed: its regex requires a variable name containing "euro", and both sites use `num`/`gesamtBetrag`. qonto-csv-parser has no unit tests and accepts English-header exports, making dot-decimal input realistic there too. Minor caveat: the Kassen `1;` path is partially shielded by GERMAN_AMOUNT_RE structural detection, but the DAVASO path (header-name column lookup) and manual columnMap bypasses are not.

**Fix-Skizze:** Replace avis-parser's parseEuroCents body and qonto-csv-parser's private parseGermanDecimal with `parseEuroDE(value) ?? 0` from @shared/utils/money, computing qonto amountCents directly in cents (deleting the local `Math.round(* 100)`). Update the DAVASO regression snapshot's pinned values to the now-correct cents (its own comment marks them as 100x too large — verify against source documents and plan a backfill for already-ingested payment_advice/qonto amounts), and add a qonto-csv-parser unit test covering dot-decimal input. Optionally widen the money-arithmetic guard regex so `Math.round(<anything> * 100)` in server/services is flagged regardless of variable name.

### util-reimpl-5: Business dates via UTC toISOString().slice(0,10) instead of local formatDateISO/todayISO/parseTimestamp — TZ-dependent off-by-one

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/routes/admin/qonto.ts:473`
- `server/routes/admin/mitarbeiterabrechnung.ts:260`
- `server/routes/admin/mitarbeiterabrechnung.ts:283`
- `server/routes/admin/mitarbeiterabrechnung.ts:330`
- `server/routes/admin/lexware-export.ts:131`
- `server/storage/billing/pipeline-reader.ts:208`
- `client/src/features/billing/utils.ts:75`
- `client/src/pages/appointment-detail.tsx:342`
- `server/services/qonto-backfill-runner.ts:105`
- `shared/utils/datetime.ts:55`
- `shared/utils/datetime.ts:398`

**Evidenz (Auditor):** qonto.ts persists `zahlungsDatum = emitted.toISOString().slice(0,10)` (payment matching date); payroll/lexware convert PG date columns via `new Date(r.date).toISOString().slice(0,10)` — with TZ=Europe/Berlin, local-midnight Dates shift to the PREVIOUS day. pipeline-reader derives the aging anchor via Date-UTC-roundtrip while the client derives the same anchor via string slice (utils.ts:71-76) — two mechanisms for one business question. datetime.ts KONVENTIONEN §3 explicitly forbids ISO-timestamp round-trips for local dates.

**Vorgeschlagene SSoT:** shared/utils/datetime.ts (formatDateISO, todayISO, parseTimestamp)

**Verifikation:** Every cited site exists and matches the claim. The Date-fallback branches in mitarbeiterabrechnung.ts:260/283/330 and lexware-export.ts:131 are LIVE, not defensive dead code: server/lib/db.ts uses @neondatabase/serverless with pg-types defaults (no setTypeParser anywhere), so raw db.execute rows return PG date columns as local-midnight JS Dates, and toISOString() shifts them to the previous day under Europe/Berlin. qonto.ts:473 persists zahlungsDatum from a timestamptz via UTC slice into a date column that qonto.ts:1605 later reads with parseLocalDate — mixed UTC-write/local-read semantics. pipeline-reader.ts:204-209 and client utils.ts:71-76 answer the identical business question (aging anchor); the client comment even admits it mirrors the pipeline-reader "EXAKT" — synchronized by comment, not code, while the rest of the aging logic is already SSoT'd in shared/domain/billing-pipeline.ts. appointment-detail.tsx:342 computes browser-side "today" as the UTC date instead of shared todayISO(). Intentionality is refuted by the repo itself: docs/refactor-masterplan.md §4a classifies "Geschäftsdatum per UTC-Slice" as drift to convert to formatDateISO (whitelisting only system timestamps and the Qonto API filter at services/qonto.ts:137, a different site), and the cited sites postdate that inventory. No guard exists: the lint rule is deferred, TZ is not pinned at boot (audit finding M25), and no test covers these mappers — while tests/equality/* deliberately pin TZ=Europe/Berlin, making the off-by-one scenario the project's reference environment. Only caveat: qonto-backfill-runner.ts:105 is audit-metadata-only (low materiality), and server/client aging anchors currently agree with each other (both UTC), so severity is closer to medium-high than high.

**Fix-Skizze:** Route all Date→"YYYY-MM-DD" business-date conversions through shared/utils/datetime.ts: add a small pgDateToISO(value: string | Date) helper (string pass-through, Date → formatDateISO) and use it in the four payroll/lexware mappers; replace qonto.ts:473 and qonto-backfill-runner.ts:105 with formatDateISO, and appointment-detail.tsx:342 with todayISO()/isPast(). Move the aging-anchor derivation into shared/domain/billing-pipeline.ts (e.g. invoiceAgingAnchorIso({ billingType, dueDate, sentAt })) and call it from both pipeline-reader.ts and client billing/utils.ts so server and client cannot drift — changing both sides together, since fixing only one would break their current (UTC-based) agreement.

### util-reimpl-6: formatKm exists 3x with different precision — regression of the exact 'Anzeige ≠ Buchung' bug Task #616 fixed

**Severity:** medium · **Verdikt:** INTENTIONAL

**Fundstellen:**
- `shared/utils/format.ts:40`
- `client/src/features/billing/utils.ts:25`
- `client/src/pages/admin/mitarbeiterabrechnung.tsx:207`
- `client/src/pages/admin/statistics/v2/economics-block.tsx:162`

**Evidenz (Auditor):** Canonical formatKm = quantizeKm + 2 decimals (doc: 'km wird projektweit mit 2 NK angezeigt … Vorher lieferte formatKm 1 NK … Anzeige ≠ Buchung'). billing/utils.ts exports a SECOND `formatKm` with maximumFractionDigits:1; payroll page `fmtKm` also 1 decimal; economics-block formats inline without quantizeKm. Same km renders '7,30' vs '7,3' depending on page; identical function name invites wrong import.

**Vorgeschlagene SSoT:** shared/utils/format.ts formatKm

**Verifikation:** All four cited sites exist with the claimed precisions, but they answer two different business questions that the repo explicitly separates and test-enforces. The Task #616 bug (Anzeige ≠ Buchung) concerned display of BOOKED km (Budget-Ledger/invoice lines); that path is intact and guarded — BudgetLedgerSection and invoice renderers use formatKmQuantityDisplay/renderLineItemQuantity, enforced by tests/architecture/km-display-via-helper.test.ts, tests/equality/budget-ledger-display-matches-booking.test.ts and tests/equality/invoice-line-item-arithmetic.test.ts. None of the three cited variants renders a booked quantity: mitarbeiterabrechnung.tsx is explicitly in the arch test's ALLOWED_PATHS ("Anzeige-Summe, bewusst NICHT die Rechnungs-Line"), billing/utils.ts formatKm carries a Task #1473 comment ("Reine Darstellung — die km-Mengen kommen fertig aus dem Reader") and is used only for reader aggregates in economics-overview-card.tsx, and economics-block.tsx formats reader aggregate sums. .agents/memory/km-display-allowlist-arch-guard.md codifies this as deliberate policy: pure display aggregates are legitimate outside the helper. The name collision is low-risk (different signatures; billing variant embeds " km" so a wrong import breaks visibly). Consolidating would couple stat-table aggregate formatting to invoice quantization for no correctness gain — exactly the over-consolidation the team avoids. Minor residue: the "projektweit mit 2 NK" doc comment in shared/utils/format.ts overstates the operative rule, and renaming billing's export (e.g. formatKmCompact) would remove the collision — polish, not the claimed medium SSoT regression.

### util-reimpl-7: todayISO/formatDateISO/parseLocalDate hand-rolled at ~20 sites, incl. twice inside shared/domain/appointments.ts

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `shared/domain/appointments.ts:270`
- `shared/domain/appointments.ts:522`
- `shared/domain/appointments.ts:527`
- `client/src/features/billing/utils.ts:45`
- `server/routes/customers/service-prices.ts:14`
- `server/storage/pricing/price-for.ts:36`
- `server/routes/standard-prices.ts:44`
- `server/routes/appointment-series.ts:113`
- `server/routes/role-wage-rates.ts:41`
- `server/storage/statistics/alerts.ts:24`
- `server/storage/tasks.ts:353`
- `server/lib/team-workload.ts:47`
- `client/src/features/admin/components/admin-cockpit.tsx:41`
- `shared/utils/datetime.ts:46`

**Evidenz (Auditor):** formatLocalIsoDate + formatSeriesDate are two byte-equivalent clones of formatDateISO in ONE shared/domain file; parseSeriesDate clones parseLocalDate; billing/utils todayIso() clones todayISO(); 10+ server route/storage sites re-build `${getFullYear()}-${pad(getMonth()+1)}-${pad(getDate())}` (5 of them in the pricing effective-date path: service-prices.ts:14,446,575,619 + price-for.ts:36). Same output today; each copy is a grep-invisible mutation point for the TZ drift in the UTC finding.

**Vorgeschlagene SSoT:** shared/utils/datetime.ts (formatDateISO, parseLocalDate, todayISO)

**Verifikation:** Opened every cited file. shared/domain/appointments.ts defines formatLocalIsoDate (line 270) and formatSeriesDate (line 527) as byte-equivalent clones of formatDateISO, and parseSeriesDate (line 522) as a clone of parseLocalDate — while line 2 of the same file already imports parseLocalDate from shared/utils/datetime and uses it at line 492. billing/utils.ts:45 and admin-cockpit.tsx:39 hand-roll todayIso() identical to todayISO() despite 8+ client files importing @shared/utils/datetime (no aliasing obstacle) and billing/utils.ts already delegating to other shared SSoTs. The pricing/wage effective-date path repeats a raw-DB-date→ISO normalizer seven times (named rawDateToISO/toDateStr copies in service-prices.ts:12, standard-prices.ts:42, role-wage-rates.ts:39, price-for.ts:33, plus inline copies at service-prices.ts:446/575/619) whose Date branch clones formatDateISO with identical local-getter semantics. alerts.ts:24, tasks.ts:353 (which also already imports parseLocalDate), and appointment-series.ts:112 are further full clones. No semantic divergence, no intentional-duplication comments, and datetime.ts's own header declares these functions the binding project-wide convention; tests/unit/datetime-helpers.test.ts guards only the SSoT, not the clones. Minor overcounts: datetime.ts:46 is the SSoT itself, and team-workload.ts:47 only builds month-start strings (partial match) — neither refutes the core claim.

**Fix-Skizze:** Delete the three private clones in shared/domain/appointments.ts and the one in appointment-series.ts, using the already-importable formatDateISO/parseLocalDate; replace the two client todayIso() copies with todayISO from @shared/utils/datetime. Add one shared helper rawDbDateToISO(value: Date | string): string in shared/utils/datetime.ts (Date branch delegating to formatDateISO, string branch substring(0,10)) and use it at the seven pricing/wage sites; swap the inline template literals in alerts.ts and tasks.ts for formatDateISO. Leave team-workload's month-start construction as-is or convert opportunistically — it is the only partial match.

### util-reimpl-8: lastDayOfMonth re-implemented in §45a consumption engine while sibling reservation-storage uses the canonical helper

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/storage/budget/consumption-engine.ts:246`
- `server/routes/appointments.ts:304`
- `server/storage/budget/reservation-storage.ts:272`
- `shared/utils/datetime.ts:370`

**Evidenz (Auditor):** consumption-engine builds the §45a month window manually (`new Date(y, m+1, 0).getDate()` + string concat) in booking-path code; appointments.ts builds month ends with an UNPADDED day (works only because day>=28). reservation-storage.ts:272 imports the canonical lastDayOfMonth — budget booking window and reservation window are produced by two different mechanisms.

**Vorgeschlagene SSoT:** shared/utils/datetime.ts lastDayOfMonth

**Verifikation:** Verified all four cited sites. consumption-engine.ts:246-248 manually rebuilds the §45a month end (new Date(y, m+1, 0).getDate() + padded concat) — semantically identical to the canonical lastDayOfMonth at shared/utils/datetime.ts:370, which docs/budget-ssot-inventory.md:244 explicitly declares the budget-SSoT for this; the file already imports from @shared/utils/datetime so there is no boundary reason for the copy. appointments.ts:304/306 rebuilds month ends with an UNPADDED day (currentMonth is 1-based per line 262), which only survives lexicographic date comparison because last-of-month days are always 2 digits — an incidental, unexpressed invariant. Meanwhile the sibling booking-path files reservation-storage.ts:272, allocation-storage.ts:92, and rebook-storage.ts:249/370 all use the canonical helper, so the same subsystem answers one calendar question via two mechanisms. No comment marks the divergence as deliberate, no architecture guard test covers date construction (tests/architecture has none matching lastDayOfMonth/getDate), and grep found two further private re-implementations (shared/domain/import-cutoff.ts:25, server/services/invoice-45b-reduction.ts:84) confirming ongoing drift. This is a pure calendar computation with no context-dependent rounding, so consolidation does not couple things that change for different reasons.

**Fix-Skizze:** In consumption-engine.ts replace the daysInMonth/monthEnd construction with lastDayOfMonth(txDate.getFullYear(), txDate.getMonth() + 1) (extend the existing @shared/utils/datetime import); in appointments.ts:304/306 replace the manual end strings with lastDayOfMonth(currentYear, currentMonth) and lastDayOfMonth(nextMonthYear, nextMonth). Optionally fold the private copies in shared/domain/import-cutoff.ts and server/services/invoice-45b-reduction.ts into the same helper and add a tests/architecture guard forbidding manual last-day-of-month construction, mirroring no-money-arithmetic-outside-helper.

### util-reimpl-9: Euro display via .toFixed(2) instead of formatEuroDE — English decimal in German UI; 2 sites fail the repo's own money guard

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/customers/components/wizard/budgets-step-validation.ts:50`
- `client/src/features/customers/components/wizard/budgets-contract-step.tsx:49`
- `client/src/features/customers/components/wizard/budgets-contract-step.tsx:48`
- `client/src/features/billing/hooks/use-billing-mutations.ts:585`
- `client/src/pages/admin/settings/letterxpress-settings.tsx:72`
- `server/routes/budget.ts:1405`
- `shared/utils/money.ts:44`

**Evidenz (Auditor):** Cap messages and toasts render '3539.00 €' / '(data.overflowCents / 100).toFixed(2)' instead of formatEuroDE's '3.539,00 €'. Replaying no-money-arithmetic-outside-helper.test.ts regexes against the tree flags use-billing-mutations.ts:585 and reduce-45b-dialog.tsx:46 TODAY (gate red or evaded). ALL-CAPS `BUDGET_45B_MAX_MONTHLY_CENTS / 100` (contract-step:48,56) evades the guard because `[Cc]ents` doesn't match `CENTS`.

**Vorgeschlagene SSoT:** shared/utils/money.ts formatEuroDE (+ case-insensitive guard patterns)

**Verifikation:** Every cited site exists as claimed. Replaying the guard test's exact regexes/allowlist (vitest itself cannot run — deps not installed) flags exactly use-billing-mutations.ts:585 and reduce-45b-dialog.tsx:46 today, with zero money-arithmetic-allowed overrides in the tree, so the gate is red. The ALL-CAPS evasion is real: the guard's case-sensitive \w*[Cc]ents?\b never matches BUDGET_45B_MAX_MONTHLY_CENTS / 100 (contract-step:48,56). budgets-step-validation.ts:50 and budget.ts:1405 evade via centsToEuroNumber(...).toFixed(2); budget.ts:1405's euroAmount is rendered raw as "{oc.euroAmount} €" in the German admin UI (budget-maintenance-cards.tsx:173), so it is display-bound, not machine format. All sites answer the same business question formatEuroDE was built for (money.ts header mandates it); the only legitimate English-decimal context (zugferd/XRechnung) is already allowlisted. Bonus drift: the reduce-45b toast (585) and its own dialog (formatAmount→formatEuroDE, line 117) format the same overflowCents differently, and the dialog's local parseEuroToCents rejects "1.234,56" which parseEuroDE parses.

**Fix-Skizze:** Replace the five display sites with formatEuroDE (letterxpress balance is euro-float: use formatEuroDE(Math.round(data.balance * 100)); budget.ts:1405: return formatEuroDE(cents, {withCurrency:false}) or raw cents and format client-side); replace reduce-45b-dialog's parseEuroToCents with parseEuroDE plus its local negative-check. Harden the guard: case-insensitive cents pattern (or add CENTS variant) and a new pattern for centsToEuroNumber\([^)]*\)\.toFixed\(.

### util-reimpl-10: Inline Number(x.replace(',', '.')) German-decimal parsing in payroll hours-account editing

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/pages/admin/mitarbeiterabrechnung.tsx:1141`
- `client/src/pages/admin/mitarbeiterabrechnung.tsx:1153`
- `shared/utils/parse-german-decimal.ts:33`

**Evidenz (Auditor):** Opening-balance and paid-hours inputs parse via `Number(anfangsbestand.replace(",", "."))` — '1.234,5' -> Number('1.234.5') = NaN -> valid German input rejected; units not stripped. The Task #819 SSoT accepts all these forms; input UX diverges from pages already using it.

**Vorgeschlagene SSoT:** shared/utils/parse-german-decimal.ts parseGermanDecimal

**Verifikation:** Verified both cited lines exist exactly as claimed (mitarbeiterabrechnung.tsx:1141 and :1153, inline Number(x.replace(",", "."))), and the failure is real: "1.234,5" becomes Number("1.234.5") = NaN, so valid German input is rejected with an error toast; units are not stripped. The shared SSoT parseGermanDecimal (shared/utils/parse-german-decimal.ts:33, Task #819) handles all these forms and is covered by tests/unit/parse-german-decimal.test.ts. Other client decimal inputs (document-appointment.tsx, travel-documentation.tsx) already use a shared parseGermanDecimal, so this page diverges from the established input pattern. No comment marks the inline version as intentional and no test guards this UI parsing (the architecture fitness function only covers server/services/appointment-import.ts). One nuance: the SSoT returns 0 for unparseable input while the UI needs to reject invalid input with a toast, so a naive swap would silently save 0 for garbage — the consolidation must preserve validation.

**Fix-Skizze:** Replace the two inline parses with the SSoT while keeping validation semantics: either add a small nullable variant (e.g. parseGermanDecimalOrNull, mirroring parseEuroDE in shared/utils/money.ts which returns null on invalid) and keep the toast on null, or pre-validate the raw string (regex for digits/separators/sign) before calling parseGermanDecimal. Separately flag that shared/utils/format.ts:51 exports a second, weaker parseGermanDecimal under the same name — the fixer should consider unifying client imports onto shared/utils/parse-german-decimal.ts.


## B. Parallele Business-Logik (zwei Funktionen, eine fachliche Frage)

### parallel-logic-1: Phantom status 'documented': ~50 hand-rolled SQL appointment-status sets parallel to the status SSoT

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/storage/statistics/cockpit.ts:34`
- `server/storage/statistics/cockpit.ts:96`
- `server/storage/statistics/economics.ts:72`
- `server/storage/statistics/economics.ts:239`
- `server/storage/statistics/revenue.ts:65`
- `server/storage/statistics/performance.ts:17`
- `server/storage/statistics/customers.ts:11`
- `server/storage/statistics/alerts.ts:80`
- `server/lib/team-workload.ts:182`
- `server/lib/team-workload.ts:335`
- `server/services/auto-breaks.ts:71`
- `server/storage/time-tracking/overview.ts:157`
- `shared/domain/appointments.ts:30`
- `server/lib/appointment-signed.ts:93`

**Evidenz (Auditor):** shared/domain/appointments.ts:14/30 defines statuses scheduled|documenting|completed|cancelled|customer_no_show — there is NO 'documented'. Yet the whole statistics layer + team-workload filter `a.status IN ('completed','documented')` (50+ sites) and hand-roll 'planned' as `IN ('scheduled','completed','documented')`, silently EXCLUDING 'documenting' appointments; time-tracking/auto-breaks use `('completed','documenting')`; the guarded SQL SSoT documentedSqlRaw (server/lib/appointment-signed.ts:93) is `status = 'completed'`. Same business question ('did work happen / is it open') answered with 3 different literal sets; shared/domain/billing-pipeline.ts:131 counts scheduled/documenting as open while cockpit drops them entirely.

**Vorgeschlagene SSoT:** Status-set constants in shared/domain/appointments.ts exposed as SQL fragment builders in server/lib/appointment-signed.ts (e.g. plannedSqlRaw/workedSqlRaw); ast-grep guard banning the literal 'documented' in SQL

**Verifikation:** Verified every cited site. (1) The phantom is real: shared/domain/appointments.ts:14/30 defines AppointmentStatus and PERSISTED_APPOINTMENT_STATUSES as scheduled|documenting|completed|cancelled|customer_no_show — no 'documented'; grep confirms no migration, and no code in server/shared/client ever writes status='documented'; the column is plain text with no CHECK (shared/schema/appointments.ts:106), so the dead literal is silently accepted by Postgres. (2) The parallel sets exist as claimed: 38 exact `IN ('completed','documented')` sites plus ~17 `IN ('scheduled','completed','documented')` sites across server/storage/statistics/{cockpit,economics,revenue,performance,customers,alerts}.ts and server/lib/team-workload.ts:182/335 — all raw SQL. This means 'documenting' appointments (work performed, docs unfinished) are silently dropped from planned revenue, worked hours, active-customer counts. (3) It is NOT intentional: the team's own memory (.agents/memory/billing-pipeline-readmodel.md 'Trap' section, MEMORY.md:125) explicitly calls this out — "There is NO documented appointment status … documenting … is SILENTLY EXCLUDED from planned" — and they engineer conservation tests around it (scheduled-only fixtures) rather than by design; tests/team-workload.test.ts:146 even seeds the phantom status into the DB to make the SQL match. (4) No guard covers it: tests/architecture/appointment-status-partition-consumers.test.ts only regex-scans Drizzle inArray/notInArray calls; raw-SQL `IN (...)` strings escape it entirely. (5) The canonical mirror already exists and is bypassed: documentedSqlRaw (server/lib/appointment-signed.ts:93) = status='completed' mirrors isAppointmentDocumented, answering the same "work documented" question the statistics hand-roll differently. One overreach in the claim: auto-breaks.ts:71 and time-tracking/overview.ts:157 use ('completed','documenting'), which the existing guard explicitly classifies as a legitimately different question (hours-in-progress view, "Stunden-Sicht") — those two sites are not part of the violation, but this does not weaken the core finding.

**Fix-Skizze:** Add status-set fragment builders next to documentedSqlRaw in server/lib/appointment-signed.ts (or a sibling appointment-status-sql.ts), derived from the shared constants — workedSqlRaw(alias) (= documentedSqlRaw, status='completed') and plannedSqlRaw(alias) (scheduled/documenting/completed) — and replace the ~55 raw literals in server/storage/statistics/* and server/lib/team-workload.ts, deleting the phantom 'documented' and fixing the tests/team-workload.test.ts:146 fixture. Extend detectPartitionLiteralRelist in tests/architecture/appointment-status-partition-consumers.test.ts to also scan raw-SQL `status IN (...)` fragments and ban any literal outside PERSISTED_APPOINTMENT_STATUSES. Note this is a deliberate behavior change (documenting appointments enter planned/worked KPIs), so the €-conservation tests built around the trap must be updated in the same change.

### parallel-logic-2: Customer-price resolution copy-pasted as SQL subquery at 13 sites, semantically diverging from the priceFor SSoT

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/storage/statistics/revenue.ts:21`
- `server/storage/statistics/revenue.ts:90`
- `server/storage/statistics/revenue.ts:330`
- `server/storage/statistics/revenue.ts:378`
- `server/storage/statistics/performance.ts:30`
- `server/storage/statistics/performance.ts:91`
- `server/storage/statistics/performance.ts:183`
- `server/storage/statistics/performance.ts:214`
- `server/storage/statistics/cockpit.ts:17`
- `server/storage/statistics/cockpit.ts:112`
- `server/storage/statistics/economics.ts:203`
- `server/storage/billing/economics-reader.ts:242`
- `server/storage/billing/pipeline-reader.ts:112`
- `server/storage/pricing/price-for.ts:45`

**Evidenz (Auditor):** Verbatim-duplicated correlated subquery `COALESCE((SELECT csp.cents FROM prices csp WHERE csp.scope='customer' AND csp.origin='customer_service_prices' ... LIMIT 1), s.default_price_cents)` at 13 sites. The TS SSoT (resolvePriceFor via server/storage/pricing/price-for.ts) resolves customer scope with ALL origins, then time-versioned scope='standard' rows, then catalog default — the SQL copies skip standard-scope prices and non-customer_service_prices origins, so statistics revenue diverges from invoiced revenue whenever a standard price row differs from services.default_price_cents. The wage side already has the correct pattern (server/storage/pricing/wage-for-sql.ts resolvedWageCentsSql).

**Vorgeschlagene SSoT:** New server/storage/pricing/price-for-sql.ts (resolvedPriceCentsSql) mirroring wage-for-sql.ts; ban the origin='customer_service_prices' fragment outside pricing/

**Verifikation:** Verified all 13 cited SQL sites contain the verbatim subquery filtering scope='customer' AND origin='customer_service_prices' with fallback straight to s.default_price_cents. The divergence from the TS SSoT is live, not theoretical: (1) contracts.ts:157 actively writes scope='customer', origin='customer_contract_rates' rows that the SQL copies skip but resolvePriceFor honors; (2) routes/standard-prices.ts (Task #1357) is a live admin UI writing scope='standard' rows that the resolver ranks above catalog default but the SQL copies never consult; (3) SQL also lacks the id-DESC tiebreaker and isBillable→0 rules of pickActive/resolvePriceFor. Invoicing (invoice-data.ts:401) uses the full SSoT via loadCustomerPriceContext, so statistics revenue diverges from invoiced revenue for contract-rate customers and standard-priced services. Not intentional: economics-reader.ts:234 comments "wie SSoT" while diverging, and wage-for-sql.ts documents the team principle that SQL aggregates must byte-for-byte mirror the TS SSoT (the exact precedent pattern). The architecture guard (tests/architecture/price-ssot-read-path.test.ts) only bans Drizzle reads of the three dropped legacy tables and cannot catch this raw-SQL origin narrowing.

**Fix-Skizze:** Create server/storage/pricing/price-for-sql.ts exporting resolvedPriceCentsSql(customerIdExpr, s, dateExpr) mirroring resolvePriceFor exactly (customer scope all origins with valid_from DESC, id DESC tiebreak → standard scope same ordering → CASE WHEN NOT is_billable THEN 0 ELSE default_price_cents END), modeled on resolvedWageCentsSql in wage-for-sql.ts, and replace the 13 fragments. Add an architecture guard test banning the origin='customer_service_prices' fragment in raw SQL outside server/routes/customers/service-prices.ts and server/storage/pricing/, plus a DB-backed parity test asserting the SQL expression equals resolvePriceFor across customer/contract-rate/standard/default fixtures.

### parallel-logic-3: Two parallel Wirtschaftlicher-Überblick economics readers with byte-identical helpers and diverging gates

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/storage/statistics/economics.ts:18`
- `server/storage/billing/economics-reader.ts:75`
- `server/storage/statistics/economics.ts:16`
- `server/storage/billing/economics-reader.ts:50`
- `server/storage/statistics/economics.ts:58`
- `server/storage/billing/economics-reader.ts:201`

**Evidenz (Auditor):** resolveRates() is byte-identical in statistics/economics.ts:18-41 and billing/economics-reader.ts:75-98; NON_BILLABLE_TYPES duplicated (economics-reader.ts:50 even comments 'SSoT-Spiegel aus economics.ts'). The two readers gate appointments differently: statistics uses phantom `status IN ('completed','documented')` while the billing reader uses documentedSqlRaw('a'); statistics collapses each appointment to ONE category via DISTINCT ON (economics.ts:58-77) while the billing reader counts per service row (Task #1752) — mixed HW+AB appointments and Erstberatung are attributed differently, so the two 'economic overview' surfaces show different numbers for the same month.

**Vorgeschlagene SSoT:** One shared economics-reader module (or shared SQL fragment file) under server/storage/; at minimum a single resolveRates + NON_BILLABLE_TYPES imported by both readers

**Verifikation:** Verified in both files: resolveRates() is functionally byte-identical (statistics/economics.ts:18-41 vs billing/economics-reader.ts:75-98, only a type-alias differs) and NON_BILLABLE_TYPES is copy-pasted with a self-confessed 'SSoT-Spiegel aus economics.ts' comment; no shared canonical home exists (shared/schema/time-tracking.ts only has the full 8-type TIME_ENTRY_TYPES) and the same 5 literals are inlined in SQL three more times. However, the claim's high-severity core is wrong: (1) the gates are behaviorally IDENTICAL — 'documented' is not a persisted AppointmentStatus (shared/domain/appointments.ts:14-36), so status IN ('completed','documented') ≡ documentedSqlRaw('a') ≡ status='completed', and the IN-idiom is the statistics-module-wide convention (30+ sites); (2) the DISTINCT-ON/duration_promised vs per-service/actual-duration and Erstberatung-as-overhead differences are deliberate, task-numbered (Tasks #1752/#1765, with comments cross-referencing the other reader) and guard-tested by tests/economics-payroll-revenue-drift.test.ts (Task #1754), which pins the billing reader to the payroll/revenue SSoT and explicitly asserts no DISTINCT-ON collapse and no fallback to duration_promised. Merging the readers or their SQL would couple surfaces that change for different reasons. Only the minimal helper/constant consolidation is a real violation — severity low/medium, not high.

**Fix-Skizze:** Hoist resolveRates() and NON_BILLABLE_TYPES into one importable location (export from server/storage/statistics/economics.ts or a small server/storage/economics-shared.ts) and import it in server/storage/billing/economics-reader.ts, deleting the mirror copy and its 'Spiegel' comment; optionally interpolate NON_BILLABLE_TYPES into the three inline SQL IN-lists (statistics/economics.ts:120,322; economics-reader.ts:312). Do NOT merge the two readers' aggregation queries or gates — the bases diverge intentionally and are enforced by tests/economics-payroll-revenue-drift.test.ts.

### parallel-logic-4: Revenue-stage funnel (Geplant/Dokumentiert/Nachgewiesen/Berechnet) implemented 3x with diverging stage definitions

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/storage/statistics/revenue.ts:60`
- `server/storage/statistics/revenue.ts:84`
- `server/storage/statistics/cockpit.ts:6`
- `server/storage/statistics/cockpit.ts:106`
- `server/storage/statistics/economics.ts:225`

**Evidenz (Auditor):** cockpit.ts computeRevenueStages (6-55) is a near-verbatim copy of revenue.ts computeStages (60-82); economics.ts stageHours (225-266) re-implements the same funnel in minutes. Divergences: 'proven' in economics requires `status IN ('completed','documented') AND id IN (signed LN)` while cockpit/revenue count ANY appointment linked to a completed LN regardless of status (a cancelled appointment counts as proven revenue in cockpit but not proven minutes in economics); 'invoiced' sums invoice_line_items.total_cents in cockpit/revenue but appointments.duration_promised in economics — same stage label, different populations.

**Vorgeschlagene SSoT:** A single stage-funnel SQL fragment builder in server/storage/statistics/ consumed by cockpit, revenue, sparklines and economics

**Verifikation:** Verified all cited sites. cockpit.ts computeRevenueStages (6-55) and revenue.ts computeStages (60-82) share verbatim-identical stage predicates, proven subquery, invoiced query, and pricing formula with no delegation between them; revenue.ts stageSparklines and ~6 more inline sites repeat the same predicates. economics.ts stageHours (225-266) implements the same labeled funnel in minutes with a genuinely diverging 'proven' definition (adds status IN ('completed','documented')) — and both funnels are rendered side-by-side on the same revenue dashboard (economics-block.tsx labels the minutes funnel Geplant/Dokumentiert/Nachgewiesen/Berechnet), so the divergence is user-visible. The repo documents intentional divergences explicitly elsewhere (.agents/memory/statistics-economics-ssot.md) but nothing blesses this one; .agents/memory/billing-pipeline-readmodel.md refers to computeStages as "the revenue funnel" singular. No guard test exists: statistics-v2.test.ts asserts only KPI shape, never cross-module value equality. Only caveats: cockpit.ts:106 sparklines is not a full funnel copy (just the pricing formula + documented predicate), and the invoiced-stage population difference in economics is partly forced by the minutes unit (non-appointment line items have no duration).

**Fix-Skizze:** Extract the stage-membership SQL fragments (planned/documented status sets, the completed-LN proven subquery, the non-storno invoice filter) and the per-appointment hourly pricing CTE builder into server/storage/statistics/common.ts (or a new stage-funnel.ts), and have revenue.ts (computeStages, stageSparklines, per-dimension queries, gap lists), cockpit.ts, and economics.ts stageHours compose them with their own aggregation measure (cents vs duration_promised minutes). Resolve the proven status-filter divergence as an explicit product decision (one definition, documented), keeping the minutes-invoiced appointment-linked population as a documented unit-forced difference, and add a drift-guard test asserting cockpit revenueByStage equals revenue byStage on a shared fixture.

### parallel-logic-5: Birthday age + occurrence logic duplicated with confirmed divergence (overdue rule, Feb-29)

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/routes/birthdays.ts:114`
- `server/routes/birthdays.ts:128`
- `server/routes/birthdays.ts:73`
- `server/services/birthday-notification-checker.ts:10`
- `server/services/birthday-notification-checker.ts:39`
- `server/services/birthday-notification-checker.ts:70`

**Evidenz (Auditor):** calculateUpcomingAge exists twice: routes/birthdays.ts:128 uses `daysUntil <= 0 ? baseAge : baseAge + 1`, birthday-notification-checker.ts:10-20 inlines its own age math with `daysUntil === 0 ? age : age + 1` (differs for overdue birthdays). The checker also re-computes 'birthday occurrence this year' as `new Date(y, birth.getMonth(), birth.getDate())` (lines 39-41, 70-72) WITHOUT the Feb-29 leap-year handling that routes/birthdays.ts getBirthdayOccurrenceInYear (73-112) has — Feb-29 birthdays roll to Mar 1 only in the notification path. Ironically the checker imports calculateDaysUntilBirthday from the route file, so the SSoT is one import away.

**Vorgeschlagene SSoT:** shared/domain/birthdays.ts holding calculateAge/calculateUpcomingAge/getBirthdayOccurrenceInYear/calculateDaysUntilBirthday; both route and checker import it

**Verifikation:** All cited sites exist as claimed: calculateUpcomingAge is implemented twice (routes/birthdays.ts:128 with `daysUntil <= 0 ? baseAge : baseAge + 1`; birthday-notification-checker.ts:10-20 with copy-pasted, character-identical inline age math plus `daysUntil === 0 ? age : age + 1`), and the checker re-derives birthday-occurrence-this-year at lines 40-41 and 69-70 via `new Date(y, month, day)` without the Feb-29→Feb-28 handling that getBirthdayOccurrenceInYear (routes/birthdays.ts:73-87) applies. Both answer the identical business question for the same entities (the age shown in the birthday list vs. the age in the notification). The checker already imports calculateDaysUntilBirthday from the route file (line 4), and auth.ts:30 imports it too — domain logic living in a route module with three consumers. No shared/domain/birthdays.ts exists, and the only test (tests/birthdays-include-past.test.ts) guards the route's helper only, not the checker's copies. One caveat vs. the audit: the divergences are latent, not live — the checker's `daysUntil !== 7` gate means daysUntil is always exactly 7 when its copies run, so `===0` vs `<=0` and the Mar-1 rollover produce identical results today. That reduces urgency but does not make it a false positive; it is textbook copy-paste drift waiting to bite on the next horizon change.

**Fix-Skizze:** Create shared/domain/birthdays.ts exporting calculateAge, calculateUpcomingAge, getBirthdayOccurrenceInYear, calculateDaysUntilBirthday (and optionally daysUntilBirthdayWithPast); have routes/birthdays.ts, routes/auth.ts, and birthday-notification-checker.ts import from it, with the checker's birthdayYear derivation switched to getBirthdayOccurrenceInYear. Move/extend tests/birthdays-include-past.test.ts to target the shared module and add cases pinning the overdue-age rule and Feb-29 year derivation.

### parallel-logic-6: Work / non-billable entry-type lists defined in 7+ places (payroll, workload, economics can drift)

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `shared/domain/time-entries.ts:156`
- `server/storage/time-tracking/payroll-hours.ts:34`
- `server/lib/team-workload.ts:196`
- `server/storage/statistics/performance.ts:19`
- `server/storage/statistics/economics.ts:16`
- `server/storage/statistics/economics.ts:120`
- `server/storage/billing/economics-reader.ts:50`
- `server/storage/billing/economics-reader.ts:312`

**Evidenz (Auditor):** The list ['bueroarbeit','vertrieb','sonstiges'] (which manual entries count as work) exists as WORK_ENTRY_TYPES (shared SSoT, time-entries.ts:156), again as PAID_MANUAL_ENTRY_TYPES in payroll-hours.ts:34 (money-relevant), and as raw SQL literals in team-workload.ts:196 and performance.ts:19; the extended non-billable list (+krankheit,+urlaub) is defined twice as NON_BILLABLE_TYPES and inlined as SQL literals 3 more times. Adding a new entry type requires 7+ coordinated edits or payroll/statistics/workload silently disagree.

**Vorgeschlagene SSoT:** shared/domain/time-entries.ts (extend with NON_BILLABLE_ENTRY_TYPES; generate SQL IN(...) fragments from the constants)

**Verifikation:** Verified all 8 cited sites plus a 9th the auditor missed (economics.ts:322). The 3-type work list exists as WORK_ENTRY_TYPES (shared/domain/time-entries.ts:156, private), PAID_MANUAL_ENTRY_TYPES (payroll-hours.ts:34, feeds payroll cents), and raw SQL literals in team-workload.ts:196 and performance.ts:19; the 5-type non-billable list is defined twice as NON_BILLABLE_TYPES (economics.ts:16, economics-reader.ts:50) and inlined as SQL literals 3 more times (economics.ts:120, economics.ts:322, economics-reader.ts:312). Attempted refutation failed: the copies declare identity with each other in comments (payroll: "deckungsgleich mit der 'Meine Zeiten'-Sicht" which uses shared isWorkEntryType; team-workload: "identisch zur Statistik-Performance-Definition"; economics-reader: "SSoT-Spiegel aus economics.ts"), so they answer the same business question by the code's own admission, coordinated only by comments. No copy delegates to another, and no guard test pins the lists together (existing drift tests cover rates/revenue, not entry-type membership). Within economics.ts the constant is used only for display ordering while the SQL literals define what is fetched, so even one file can drift internally. The 5-type list is exactly WORK_ENTRY_TYPES + FULL_DAY_ENTRY_TYPES (time-entries.ts:54), both already in the shared module.

**Fix-Skizze:** Export WORK_ENTRY_TYPES from shared/domain/time-entries.ts and add NON_BILLABLE_ENTRY_TYPES = [...WORK_ENTRY_TYPES, ...FULL_DAY_ENTRY_TYPES]; have payroll-hours.ts, economics.ts, and economics-reader.ts import them (keeping distinct local names like PAID_MANUAL_ENTRY_TYPES as aliases so a deliberate future divergence stays possible), and replace the five inline SQL IN(...) literals with fragments generated from the constants via drizzle inArray/sql.join.

### parallel-logic-7: Prospect contact-update Zod schema hand-mirrored between shared schema and employee route (already drifted)

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/routes/prospects.ts:54`
- `server/routes/prospects.ts:36`
- `shared/schema/prospects.ts:167`
- `shared/schema/prospects.ts:123`

**Evidenz (Auditor):** routes/prospects.ts:54 prospectContactUpdateSchema re-declares the field set of shared updateProspectSchema (comment admits 'Wir spiegeln hier bewusst den Feldumfang des Admin-Endpunkts'). Confirmed drift: the route copy validates pflegegrad with .int() (line 63) while shared/schema/prospects.ts:137 does not — admin endpoint accepts 2.5, employee endpoint rejects it. inlineProspectSchema (routes/prospects.ts:36-47) additionally accepts plz with NO format validation.

**Vorgeschlagene SSoT:** shared/schema/prospects.ts exporting a contact-field subset both endpoints .pick() from

**Verifikation:** Verified all cited sites. server/routes/prospects.ts:54-64 hand-copies the contact-field subset of shared updateProspectSchema/insertProspectSchema with identical validators and identical German error strings, and its own comment (lines 49-53) admits deliberate mirroring of the admin endpoint's field scope — i.e., intent is to stay identical, not to diverge. Drift confirmed: route line 63 validates pflegegrad with .int() while shared/schema/prospects.ts:137 lacks .int(), so the admin PATCH (server/routes/admin/prospects.ts:74) accepts 2.5 where the employee PATCH rejects it (DB column is integer, so the shared side is the buggy one). inlineProspectSchema (lines 36-47) is a third divergent copy: plz with no format check, email as bare string. Additionally, routes/prospects.ts imports plzSchema from @shared/schema/common (identical regex at common.ts:175) but never uses it, re-inlining the regex at line 61. The only test (tests/policies/prospects-update-strict.test.ts) guards admin mass-assignment strictness, not schema parity. Neither schema is a wrapper over the other; no design rationale exists for the copy itself.

**Fix-Skizze:** In shared/schema/prospects.ts, add .int() to insertProspectSchema's pflegegrad (matching the integer DB column) and export a contact-subset schema, e.g. prospectContactUpdateSchema = updateProspectSchema.pick({vorname, nachname, telefon, email, strasse, nr, plz, stadt, pflegegrad}) (pick on the partial+strict object preserves optional+strict semantics). Replace the hand-copy in server/routes/prospects.ts:54-64 with that export, and rebuild inlineProspectSchema from insertProspectSchema.shape (or the picked schema extended with required vorname/nachname and quelleDetails) so plz/email get real validation; also use shared plzSchema instead of the re-inlined regex.

### parallel-logic-8: PLZ validation: canonical plzSchema exists but 8+ inline regex copies with 3 different error texts

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `shared/schema/common.ts:175`
- `shared/schema/appointments.ts:223`
- `shared/schema/appointments.ts:250`
- `shared/schema/insurance.ts:85`
- `shared/schema/prospects.ts:135`
- `server/routes/admin/customers.ts:279`
- `server/routes/admin/customers.ts:824`
- `server/routes/customers.ts:98`
- `server/routes/prospects.ts:61`

**Evidenz (Auditor):** shared/schema/common.ts:175 defines plzSchema (`/^\d{5}$/`, 'PLZ muss 5 Ziffern haben'), but the same regex is re-inlined with divergent messages: 'Ungültige PLZ (5 Stellen erwartet)' (admin/customers.ts:279,824), 'PLZ muss 5-stellig sein' (customers.ts:98), plus 4 shared-schema files; one prospect endpoint validates plz not at all.

**Vorgeschlagene SSoT:** shared/schema/common.ts plzSchema (+ optional/empty-string variants defined beside it)

**Verifikation:** Opened every cited file: plzSchema exists at shared/schema/common.ts:175 but has zero call sites (grep shows only its definition and a dead, unused import at server/routes/prospects.ts:7). All 8 cited inline /^\d{5}$/ copies exist exactly as claimed, with 3 divergent server-side error texts ("PLZ muss 5 Ziffern haben", "Ungültige PLZ (5 Stellen erwartet)" at admin/customers.ts:279/824, "PLZ muss 5-stellig sein" at customers.ts:98) plus a 4th variant in the client wizard. server/routes/prospects.ts:43 (inlineProspectSchema) indeed accepts plz with no format validation at all. All sites answer the identical business question — valid German Postleitzahl — for addresses of customers, prospects, insurers, and doctors; the only variation is optional/nullable/empty-string wrapping. No site delegates to plzSchema, no guard test enforces consistency, and the dead import shows consolidation was intended but never done.

**Fix-Skizze:** In shared/schema/common.ts keep plzSchema and add sibling variants (e.g. optionalPlzSchema = plzSchema.optional(), nullableEmptyPlzSchema = plzSchema.or(z.literal("")).optional().nullable()) built from one exported PLZ_REGEX and message constant; replace the 8 server/shared inline regexes with these variants, use plzSchema (empty-ok variant) for inlineProspectSchema.plz at server/routes/prospects.ts:43, and export PLZ_REGEX/message for the 4 imperative client-hook validators. Add a small test asserting the shared variants reject 4/6-digit and alphanumeric input so the contract is guarded.

### parallel-logic-9: Contract create/update schemas re-declared inline with hardcoded enums instead of shared CONTRACT_* constants

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/routes/admin/customers/contracts.ts:37`
- `server/routes/admin/customers/contracts.ts:47`
- `shared/schema/contracts.ts:54`
- `shared/schema/contracts.ts:57`
- `server/routes/customers.ts:179`

**Evidenz (Auditor):** admin/customers/contracts.ts:37-53 hardcodes z.enum(["week","month","year"]) and z.enum(["active","paused","terminated"]) instead of CONTRACT_PERIOD_TYPES/CONTRACT_STATUS from shared/schema/contracts.ts:54-55, and re-declares the field rules of insertCustomerContractSchema with drift (hoursPerPeriod .int() only in route; notes max-500 only in shared). A new period type added to the shared constants would not propagate to the admin endpoints.

**Vorgeschlagene SSoT:** Derive route schemas from insertCustomerContractSchema.partial().pick(...) in shared/schema/contracts.ts

**Verifikation:** All cited sites exist as described: server/routes/admin/customers/contracts.ts:43,44,52 hardcode z.enum(["week","month","year"]) and z.enum(["active","paused","terminated"]) while shared/schema/contracts.ts:54-55 exports CONTRACT_PERIOD_TYPES/CONTRACT_STATUS used by insertCustomerContractSchema. The route schemas feed customerManagementStorage.createCustomerContract, whose parameter is typed InsertCustomerContract (inferred from the shared schema) — so all sites validate the same columns on the same write path, and adding a value to the shared constants would compile cleanly while admin endpoints silently reject it. Claimed drift verified (hoursPerPeriod .int() only in route; notes max-500 only in shared) plus additional drift the auditor missed: create route defaults periodType to "week" (line 88) while shared schema and DB column default to "month", and customer-creation-helpers.ts:324 / admin/customers.ts:337 also hardcode or skip the enum. insertCustomerContractSchema is never used for runtime request validation anywhere, no route is a wrapper over it, and no guard test pins the enums together. The customers.ts:179 citation is the weakest (only duplicates the vereinbarteLeistungen max-2000 rule) but is still the same field rule.

**Fix-Skizze:** Minimum safe fix: import CONTRACT_PERIOD_TYPES/CONTRACT_STATUS into the admin route and replace the hardcoded z.enum literals, add .int() to hoursPerPeriod in the shared schema, and reconcile the create-route default ("week") with the shared/DB default ("month") — one deliberate answer. Optionally derive the route schemas in shared/schema/contracts.ts via insertCustomerContractSchema.omit({customerId:true}).partial().pick(...), but strip the shared defaults for the PATCH schema and keep field selection route-local (no status on create, no notes) since those differences are intentional authorization scoping, not drift.

### parallel-logic-10: Customer postal-address block built by two independent functions despite declared SSoT (Task #1030)

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `server/lib/customer-address-format.ts:10`
- `server/storage/budget-recipients.ts:47`
- `server/storage/budget-recipients.ts:59`
- `shared/utils/format.ts:101`

**Evidenz (Auditor):** formatCustomerMasterAddress (customer-address-format.ts:10-20) is the declared SSoT for the 'strasse nr\nplz stadt' block; budget-recipients.ts:47-57 buildCustomerAddress re-implements the identical output independently for invoice recipients — a fix in one will not reach the other. buildInsuranceAddress (budget-recipients.ts:59-76) is a third assembler; shared/utils/format.ts:101 formatAddress is an overlapping single-line variant.

**Vorgeschlagene SSoT:** Move formatCustomerMasterAddress into shared (e.g. shared/domain/address.ts) with multiline/inline variants; budget-recipients imports it

**Verifikation:** Verified in code: buildCustomerAddress (server/storage/budget-recipients.ts:47-57) independently re-implements the exact two-line customer master address block that formatCustomerMasterAddress (server/lib/customer-address-format.ts:10-20) is explicitly documented (Task #1030) to own — including its declared scope as invoice recipient for Selbstzahler, which is exactly what budget-recipients uses it for (line 129, "private" pot). Logic diff shows byte-identical output except a degenerate whitespace-only edge (SSoT returns null, copy returns " "), proving re-implementation, not a different rule. No wrapper relationship, no import barrier (file already imports ../lib/db), and no guard test: the Task #1041 drift-detector test (tests/equality/ln-customer-address-ssot.test.ts) pins only the orchestrator and delivery paths, not budget-recipients — so an SSoT fix would silently not propagate. However, two of the four cited sites are over-reach: buildInsuranceAddress (budget-recipients.ts:59-76) formats a different entity (insurance provider with legacy anschrift/plzOrt fields) and shared/utils/format.ts:101 formatAddress is a client-only single-line UI display helper with a human-facing fallback string — neither answers the same business question and forcing them into the SSoT would be harmful over-consolidation.

**Fix-Skizze:** Delete buildCustomerAddress from server/storage/budget-recipients.ts and import formatCustomerMasterAddress from ../lib/customer-address-format (a server-local import suffices; moving it to shared/ is unnecessary since no client code needs the multiline block). Leave buildInsuranceAddress and shared formatAddress untouched, and optionally extend the tests/equality drift-detector to pin budget-recipients to the SSoT.


## C. Client/Server-Drift (Anzeige rechnet anders als Buchung)

### client-server-drift-1: Per-appointment minutes attribution re-implemented in day-detail panel (4th copy)

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/time-tracking/components/day-detail-panel.tsx:44-78`
- `client/src/features/time-tracking/components/day-detail-panel.tsx:58`
- `server/storage/time-tracking/overview.ts:128-173`
- `server/storage/time-tracking/payroll-hours.ts:308-309`
- `shared/domain/appointments.ts:116-118`

**Evidenz (Auditor):** Client getAppointmentServices() re-implements the server rule 'completed||documenting -> actualDurationMinutes ?? plannedDurationMinutes' (overview.ts:157-161, payroll SQL COALESCE(actual,planned) at payroll-hours.ts:308) and ADDS a fallback the server lacks: appointments without service rows contribute `durationPromised` minutes (client lines 70-77) but 0 minutes server-side. Also uses local predicate `status === 'completed' || 'documenting'` instead of shared isAppointmentDocumented (Task #1496 changed that SSoT once already). Day-panel sums can diverge from month overview and payroll for the same appointments; no equality test touches the client path.

**Vorgeschlagene SSoT:** shared/domain/appointment-minutes.ts: effectiveServiceMinutes(appt, services), consumed by overview.ts, payroll-hours.ts (lockstep-tested SQL mirror) and the panel

**Verifikation:** Verified day-detail-panel.tsx:58-62 duplicates overview.ts:157-161 exactly (status-gated actual??planned rule), applied to the very service rows the server ships in the same TimeOverviewData payload it aggregates — so day-panel chips and the month summary on the same page derive minutes twice. Confirmed the client-only durationPromised fallback (lines 70-77) diverges from server behavior (overview iterates only service rows; payroll INNER JOINs appointment_services), that service-less appointments can exist (addAppointmentServices early-returns on empty; Erstberatung attaches a row only if the catalog service exists), and that the divergence feeds the client-side EU-Rentner 3h/day warning while the month-level warning uses server aggregates. No test covers the client path (only a no-show data-testid guard touches the file). The same function's no-show branch already delegates to shared computeNoShowWage — showing the intended architecture. Caveats: the isAppointmentDocumented sub-claim is wrong (that SSoT is completed-only per Task #1496; the rule intentionally includes 'documenting', identically in overview.ts), '4th copy' miscounts (~30 documented-scoped SQL COALESCE mirrors exist by established pattern; payroll-hours.ts:308 is completed-scoped and consistent), and severity is medium rather than high (view/warning drift, not payroll corruption).

**Fix-Skizze:** Add shared/domain/appointment-minutes.ts with effectiveServiceMinutes(status, {actualDurationMinutes, plannedDurationMinutes}) encoding '(completed||documenting) -> actual ?? planned, else planned', consumed by overview.ts and the panel's getAppointmentServices; make an explicit decision on the service-less-appointment fallback (adopt durationPromised server-side or drop it client-side) and add a panel-vs-overview parity test. Leave the ~30 documented-scoped SQL COALESCE sites as mirrors per the existing lockstep-test pattern rather than folding them in.

### client-server-drift-2: Leistungsnachweis display totals use 'actual||0' while invoice booking uses 'actual ?? planned'

**Severity:** high · **Verdikt:** INTENTIONAL

**Fundstellen:**
- `client/src/pages/service-record-detail.tsx:206-212`
- `server/services/invoice-data.ts:496`

**Evidenz (Auditor):** Client: `aptServices.reduce((s,svc) => s + (svc.actualDurationMinutes || 0), 0)` plus client-side travel/customer km sums. Server invoice booking: `Math.round(svc.actualDurationMinutes ?? svc.plannedDurationMinutes ?? 0)`. For a service with actualDurationMinutes === null the customer-facing service-record page shows fewer total minutes than the invoice bills for the same month — display != booking, uncovered by tests/equality (invoice-line-item-arithmetic covers only billing.tsx).

**Vorgeschlagene SSoT:** Same shared effectiveServiceMinutes SSoT, or server delivers totalMinutes/totalTravelKm/totalCustomerKm in the service-record DTO

**Verifikation:** Both cited sites exist verbatim, but the claimed customer-facing drift is unreachable: the fallbacks only differ when actualDurationMinutes is null, and no write path can produce a null-actual service row on an LN appointment. LNs link only status='completed' appointments (service-records-storage.ts:311); no-shows are explicitly excluded from LNs and service billing (service-records.ts:194-198, Task #1518, and invoice-data.ts:436 skips them). Completed appointments arise only via (a) documentation — documentServiceEntrySchema enforces min 1 minute and updateAppointmentServiceDocumentation (appointments-storage.ts:402-489) updates submitted rows and deletes non-submitted ones — or (b) Excel import, which always writes actualDurationMinutes (appointment-import.ts:795,1097,1319). replaceAppointmentServices, the only routine that could reintroduce planned-only rows, has zero callers. So on all reachable data the two expressions are extensionally equal (actual=0 also agrees: 0||0=0, 0??planned=0). The residual difference is semantically motivated, not accidental: the LN page is the customer-signed attestation of performed work — its per-row rendering (service-record-detail.tsx:432-439) likewise shows only documented actuals, and displaying planned minutes there would misstate what the customer signs — while invoice-data's '?? planned' is a defensive legacy-data belt on the billing path, a convention the team also uses in time-tracking/overview.ts:158 but deliberately not in budget rebooking (rebook-storage.ts:656,826 uses 'actual ?? 0'). Forcing one shared effectiveServiceMinutes would couple attestation-display semantics to billing fallback policy. Severity 'high' is unsupported.

**Fix-Skizze:** No consolidation. If the team wants belt-and-suspenders, add a cheap equality test asserting that for every completed appointment fixture, sum(actual||0) === sum of buildLineItemsFromAppointments durationMinutes (guarding the invariant that documented appointments never carry null actuals), or a DB CHECK/startup audit that completed appointments have no null actualDurationMinutes — rather than sharing the fallback expression.

### client-server-drift-3: 'Open invoices €' computed 3 different ways (cockpit tile, cluster headers, pipeline SSoT)

**Severity:** high · **Verdikt:** FALSE_POSITIVE

**Fundstellen:**
- `client/src/features/admin/components/admin-cockpit.tsx:207-208`
- `client/src/features/billing/components/invoice-list.tsx:145-152`
- `shared/domain/billing-pipeline.ts:385-404`
- `server/routes/billing.ts:220-232`
- `server/routes/billing.ts:244-248`

**Evidenz (Auditor):** Cockpit tile sums grossAmountCents over /billing/open-for-match (only unclaimed 'versendet' invoices, full gross); invoice-list sums grossAmountCents per action cluster (grouping via shared assignInvoiceActionCluster but € summed locally); the server SSoT summarizePipelineCents (€-Konservierung) serves /billing/pipeline. Both client sums ignore openAmountCents from classifyPaymentDifference (billing.ts:231) for teilweise_bezahlt invoices, so three adjacent admin screens answer 'how many € open' differently.

**Vorgeschlagene SSoT:** Feed cockpit tile and cluster € from the /billing/pipeline reader (summarizePipelineCents); open-for-match stays a matching list without UI €-aggregation

**Verifikation:** The three sums answer different business questions, not one. (1) The cockpit tile (admin-cockpit.tsx:207-208) sums GROSS cents of /billing/open-for-match, which returns only status==='versendet' invoices not claimed by a payment (billing.ts:244-248) across ALL months — no teilweise_bezahlt invoice can appear there, so the claim that it 'ignores openAmountCents' is factually wrong for this site. (2) The cluster headers (invoice-list.tsx:145-152) are list subtotals of the user-filtered rows per cluster, shown even for the paid ('abgeschlossen') and 'storniert' clusters — proving they mean 'gross of listed rows' (matching the gross shown on each row, invoice-row.tsx:164-165, with openAmountCents rendered separately as a 'Rest offen' badge), not 'open €'; using openAmountCents would break the Σ(rows)=header invariant. (3) summarizePipelineCents is fed NET cents (pipeline-reader.ts:190) and is strictly single-month scoped (billing.ts:255-262) for €-conservation of the month lifecycle — a different amount basis, scope, and purpose. The suggested consolidation (drive tile and headers from /billing/pipeline) is semantically infeasible: net vs gross, one month vs global, and cluster subtotals must match arbitrary client filters the pipeline endpoint cannot serve. The actual classification logic is already the SSoT: both views compose assignInvoiceStage/assignInvoiceActionCluster from shared/domain/billing-pipeline.ts, anchored by tests/architecture/billing-pipeline-stage-identity.test.ts. What remains per site is a trivial reduce over cents on different populations — incidental duplication. Side note (separate issue, not this claim): assignInvoiceStage has no case for 'teilweise_bezahlt', which falls through default to 'rechnung_erstellt'/'zu_versenden' — worth its own ticket.

### client-server-drift-4: EU-Rentner working-time limits exist ONLY client-side, twice, with inconsistent formulas

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/time-tracking/components/day-detail-panel.tsx:113-134`
- `client/src/features/time-tracking/components/time-overview-summary.tsx:139-149`
- `server/storage/time-tracking/payroll-hours.ts:113-119`
- `shared/domain/time-entries.ts:179`

**Evidenz (Auditor):** Daily >=3h rule (day panel, full-day entry hardcoded as 480 min) and monthly 15h/week rule (`15 * daysInMonth/7`, overview summary) are two separate hand-rolled client formulas over different hour bases. No server or shared implementation exists (isEuRentner is only passed through; shared knows only ARBZG_MAX_DAILY_MINUTES=600). The 480-min assumption contradicts server dailySollHours (monthlyWorkHours/21.7 resp. 2.5h minijob). A compliance rule enforced nowhere in the booking path can silently diverge from payroll.

**Vorgeschlagene SSoT:** shared/domain/eu-rentner-limits.ts (daily + monthly check, one hour basis), consumed by both client components and mirrored as payroll warning

**Verifikation:** Both cited client formulas exist verbatim: day-detail-panel.tsx:113-134 hardcodes full-day=480min and counts every entry type except "verfuegbar" (so urlaub/krankheit/pause count toward the 3h/day check), while time-overview-summary.tsx:139-149 computes 15*(daysInMonth/7) over a service-minutes base that deliberately excludes absences (guarded server-side by tests/time-overview-absence-hours-separation.test.ts). Repo-wide grep confirms isEuRentner is pure pass-through everywhere server-side (payroll-hours.ts:40,70,211,226,513; auth.ts; lexware-export.ts) — no server or shared limit logic exists. The 480-min assumption contradicts the documented SSoT dailySollHours (payroll-hours.ts:113-119: monthlyWorkHours/21.7, minijob 2.5h), and the day panel bypasses the shared isWorkEntryType helper (shared/domain/time-entries.ts:156-161) that the server uses. Concrete divergence: a full vacation day shows a false 8h daily-limit warning but adds 0h to the monthly limit. No test covers either client formula, and a planning doc envisions an admin-side "EU-Rentner-Limit fast erreicht" stat that would need exactly the missing shared implementation.

**Fix-Skizze:** Create shared/domain/eu-rentner-limits.ts exporting the 3h/day and 15h/week constants plus daily/monthly check functions over ONE hour basis: work minutes = appointment/service minutes + entries filtered via the existing isWorkEntryType (excluding absences and pauses, matching the Task #1585 invariant), with full-day conversion parameterized on the employee's daily Soll instead of a hardcoded 480. Consume it from both client components and, since dailySollHours currently lives in server/storage/time-tracking/payroll-hours.ts, either move that helper into shared or pass its result in — then mirror the monthly check as a payroll/overview warning server-side.

### client-server-drift-5: Appointment STATUS_LABELS tripled: shared SSoT + 2 diverging client maps

**Severity:** high · **Verdikt:** CONFIRMED

**Fundstellen:**
- `shared/domain/appointments.ts:68-75`
- `client/src/components/patterns/status-badge.tsx:40-54`
- `client/src/components/patterns/status-badge.tsx:200`
- `client/src/features/team/components/employee-time-card.tsx:10-18`
- `client/src/pages/appointment-detail.tsx:251`

**Evidenz (Auditor):** Shared SSoT: cancelled='Storniert', customer_no_show='Kunde nicht angetroffen'. status-badge.tsx copy says cancelled='Abgesagt' and omits customer_no_show, so `statusLabels[v] || v` renders the raw enum 'customer_no_show' on the appointment detail page. employee-time-card.tsx carries a stale vocabulary (planned/confirmed/in_progress/documented/invoiced) whose keys mostly don't exist in the status model, so real statuses scheduled/documenting/customer_no_show fall to a gray default with raw text.

**Vorgeschlagene SSoT:** Delete both maps, import STATUS_LABELS from shared/domain/appointments.ts (colors stay in design-system tokens); ast-grep guard against status-key object literals outside shared

**Verifikation:** All cited sites exist and label the same business question ("German display label for appointments.status"). shared/domain/appointments.ts:68-75 is the exhaustive Record<AppointmentStatus,string> SSoT (cancelled='Storniert', customer_no_show='Kunde nicht angetroffen'), already used by server/routes/month-closing.ts and client/src/pages/admin/prospects.tsx:222. status-badge.tsx:40-46 diverges (cancelled='Abgesagt', customer_no_show missing), and its only call site — appointment-detail.tsx:251 — passes appointment.status raw while line 230 proves customer_no_show is reachable there, so users see the raw enum string (and getStatusColors in design-system/tokens.ts also lacks the key, falling back to the scheduled color). employee-time-card.tsx:10-18 labels AppointmentWithCustomerName, which extends Appointment (shared/api/time-tracking.ts:90) — same entity — yet 5 of its 7 keys (planned/confirmed/in_progress/documented/invoiced) do not exist in AppointmentStatus, so scheduled/documenting/customer_no_show hit the gray raw-text fallback at line 186. Neither map is a wrapper over the shared one, no comment marks the wording divergence as deliberate, and tests/unit/appointment-status-partition.test.ts guards only the status-set partition, not label consistency across these copies.

**Fix-Skizze:** Delete the local statusLabels in status-badge.tsx and the label half of APPOINTMENT_STATUS_LABELS in employee-time-card.tsx; import STATUS_LABELS from @shared/domain/appointments in both (colors/icons stay client-side — add customer_no_show entries to statusIcons and getStatusColors, and re-key the time card's color map to the real AppointmentStatus values, typed Record<AppointmentStatus, ...> so tsc enforces exhaustiveness). Optionally add the proposed ast-grep/lint guard against status-key object literals outside shared/.

### client-server-drift-6: Month 'Gesamt'/'Dokumentiert' totals summed client-side from an open-ended bucket set

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/time-tracking/components/time-overview-summary.tsx:115-137`
- `client/src/features/time-tracking/components/time-overview-summary.tsx:166`
- `server/storage/time-tracking/overview.ts:82-263`
- `server/storage/time-tracking/overview.ts:348`

**Evidenz (Auditor):** Client hand-sums completedTotal/documentedTotalWithLeer/totalServiceMinutes/totalKm from server buckets; the comment at lines 133-135 documents the drift that already happened once (Leerfahrten bucket added server-side, client total missed it until patched). Server sends no totals for the employee view (admin view has totalWorkMinutes). tests/equality/admin-vs-employee-hours compares server paths only, never this client aggregation. Next new bucket silently breaks the displayed total again.

**Vorgeschlagene SSoT:** Server computes totals in the overview DTO; client renders only; DTO-shape test like budget-overview-dto-shape

**Verifikation:** Verified all cited sites: the client (time-overview-summary.tsx:115-137,166) hand-sums completedTotal/documentedTotalWithLeer/totalServiceMinutes/totalKm from server buckets; the 133-135 comment documents the Leerfahrten-must-be-included invariant and the DTO history (shared/api/time-tracking.ts:150-157) shows that optional bucket was added later with changed semantics — a new optional bucket compiles cleanly while silently dropping out of the displayed totals AND the EU-Rentner 15h/week legal warning (lines 139-149). TimeOverviewData carries no totals and getTimeOverview returns buckets only. tests/equality/admin-vs-employee-hours.test.ts compares server-path appointment-ID sets only; no test asserts the client totals (the sole test touching the component guards km formatting). The server already computes parallel sums for the same questions (payroll-hours.ts:489 total km with the identical 4-part decomposition; :497 hwErfasst whose comment demands taxonomy parity with the Mitarbeiter-Sicht), so consistency rests on comments across the wire. Minor evidence flaw: overview.ts:348 totalWorkMinutes is in getOpenTasks (missing-breaks), not an admin month total — does not affect the core claim. Repo convention (budget-overview-dto-shape.test.ts, server-side-grouping DTO comments) shows this is not intentional client-side derivation.

**Fix-Skizze:** Extend TimeOverviewData with server-computed totals (documentedTotalMinutes incl. leerfahrten.wageMinutes, plannedTotalMinutes, totalServiceMinutes, totalKilometers) accumulated in getTimeOverview next to the bucket accumulation, and make TimeOverviewSummary render them instead of re-summing. Add a tests/equality DTO-shape/consistency test (pattern: budget-overview-dto-shape) asserting each total equals the sum of all emitted bucket fields, so adding a bucket without updating the total fails the test instead of silently skewing the display and the EU-Rentner warning.

### client-server-drift-7: Qonto match amount check re-implements payment-difference SSoT without tolerance/skonto

**Severity:** medium · **Verdikt:** INTENTIONAL

**Fundstellen:**
- `client/src/features/qonto/components/transactions-tab.tsx:189-204`
- `shared/domain/qonto/payment-difference.ts:27`
- `shared/domain/qonto/payment-difference.ts:58-87`
- `server/routes/admin/qonto.ts:410-478`

**Evidenz (Auditor):** Client decides the mismatch-confirm dialog via exact `selectedSum !== txAmount` over grossAmountCents. The SSoT classifyPaymentDifference (used by ALL server match paths per its header) treats |diff| <= 100 cents as 'tolerated' full payment and accounts for skonto. A 40-cent difference triggers the scary mismatch dialog although the server books it as paid; if the tolerance is raised via company_settings (announced in the SSoT comment) the UI diverges further.

**Vorgeschlagene SSoT:** Use classifyPaymentDifference/isPaymentFullyCovered (shared, client-importable) for the dialog decision

**Verifikation:** All cited sites exist and the factual behavior is as described (40-ct-off selection shows the dialog; server books it "bezahlt" as tolerated). But they answer different business questions: shared/domain/qonto/payment-difference.ts is the write-path gate for "may this be booked as full payment" (scoped that way by .agents/memory/qonto-payment-mismatch-bind-flag.md: "Gates live in EVERY write path"), while transactions-tab.tsx:189-204 is the Task #1711 selection-error guard whose comments explicitly state only exact hits skip confirmation because mis-assignments are laborious to correct. The client never re-implements classification — for display/filtering it consumes server-computed tx.paymentDifferenceResult (lines 245-247). Skonto is irrelevant here: both /match and /bulk-match classify with skonto=0 (skontoCents is Avis-path-only per the SSoT's own docs). The exact-equality predicate over integer cents is identical to the SSoT's `exact` branch, so there is no rounding rule that can drift; and gating the dialog on isPaymentFullyCovered would change behavior — sub-tolerance mis-selections (1 EUR today, more once tolerance moves to company_settings) would be assigned and booked paid with no confirmation, coupling a UX confirm threshold to a booking tolerance that changes for different reasons.

**Fix-Skizze:** No consolidation. If the dialog's tone for within-tolerance differences bothers the team, optionally soften the copy (e.g., note "Differenz liegt innerhalb der Buchungstoleranz" by importing PAYMENT_DIFFERENCE_TOLERANCE_CENTS for display only) while keeping the exact-equality trigger, and add a comment/test pinning that the dialog deliberately does NOT use the booking tolerance.

### client-server-drift-8: isEntryLocked duplicated: client gating vs server enforcement, no shared function

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/time-tracking/constants.ts:42-49`
- `server/routes/time-entries.ts:216-218`
- `server/routes/time-entries.ts:432-433`

**Evidenz (Auditor):** Identical rule (lockedTypes ['urlaub','krankheit'], entryDate in the past) implemented twice with the same name but no shared module; server additionally applies '&& !isAdmin' at call sites. Any change to the locked-type list or the date boundary on one side makes the UI show edit buttons whose requests 4xx (or lock entries the server would accept).

**Vorgeschlagene SSoT:** Lift into shared/domain/time-entries.ts (next to FULL_DAY_ENTRY_TYPES) and import on both sides

**Verifikation:** Read both implementations in full: client/src/features/time-tracking/constants.ts:42-49 and server/routes/time-entries.ts:216-219 encode the identical rule — entryType in ["urlaub","krankheit"] AND entryDate before today@midnight (server's isPast in shared/utils/datetime.ts:125-130 is exactly the client's inline parseLocalDate < today check). Both gate the same action set with the same admin exemption (client day-detail-panel.tsx:269/305 shows edit/delete only when `!locked || isAdmin`; server PUT:433 and DELETE:563 return 403 when `isEntryLocked && !isAdmin`). Neither delegates to the other, no shared export exists, no test pins client/server parity, and the repo's own shared/domain/time-entries.ts already consolidates exactly this kind of hook/server duplicate (validateTimeRange) and holds the related ["urlaub","krankheit"] constant — so the split is not intentional design.

**Fix-Skizze:** Add to shared/domain/time-entries.ts: `const LOCKED_ENTRY_TYPES = ["urlaub","krankheit"] as const` (separate from FULL_DAY_ENTRY_TYPES, which coincides only incidentally) and `export function isEntryLocked(entry: { entryType: string; entryDate: string }): boolean` built on isPast from shared/utils/datetime. Delete the local copy in server/routes/time-entries.ts and replace the client version in constants.ts with a re-export/import (adapting the two-arg call in day-detail-panel.tsx), leaving the !isAdmin exemption at call sites unchanged; add a small unit test for the boundary (yesterday locked, today/future not, non-locked types never).

### client-server-drift-9: Local formatKm in billing re-introduces the 1-decimal drift fixed by Task #616

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/billing/utils.ts:23-27`
- `shared/utils/format.ts:34-43`
- `shared/domain/invoice-line-items.ts:26-30`
- `client/src/features/billing/components/economics-overview-card.tsx:33`

**Evidenz (Auditor):** Shared SSoT formatKm = quantizeKm (2-decimal commercial rounding, same quantization as invoice line items) + toFixed(2); its comment states 1-decimal display previously caused 'Anzeige != Buchung' ('70,0 km' vs '7,30 km'). billing/utils.ts shadows it with `maximumFractionDigits: 1` and no quantization, used for km quantities in the economics card that must match invoice line items: 7.35 km renders '7,35' on the invoice but '7,4' in economics.

**Vorgeschlagene SSoT:** Delete local function, import formatKm from @shared/utils/format; guard against shadowing shared export names

**Verifikation:** All cited sites exist as claimed: client/src/features/billing/utils.ts:25-27 shadows the shared formatKm name with 1-decimal, unquantized formatting, used for km in economics-overview-card.tsx:33,204, while shared/utils/format.ts:40-43 (Task #616) declares km is displayed project-wide with 2 decimals via quantizeKm and its file header forbids local formatter copies. I refuted the 'aggregates are intentionally different' defense: identical monthly km aggregates elsewhere (time-overview-summary.tsx, day-detail-panel.tsx, appointment-travel-card.tsx) all use the shared 2-decimal formatKm via the client/src/lib/utils.ts re-export, and e2e tests pin "12,70"/"8,00" output — billing is the sole 1-decimal outlier. No test pins the local 1-decimal behavior, and the existing architecture guard (tests/architecture/km-display-via-helper.test.ts) misses it only because its regex /\$\{[^}]+\}\s*km\b/ cannot match the nested braces in { maximumFractionDigits: 1 }; billing/utils.ts is not in the guard's justified allowlist, unlike every deliberate exception. Caveat: the auditor's invoice-mismatch example overstates severity — economics km are monthly aggregates including non-billable time-entry km (economics-reader.ts:510,602), so no single figure appears both on an invoice and in the card; this is a display-consistency SSoT violation, not a booking-integrity bug.

**Fix-Skizze:** Delete the local formatKm in client/src/features/billing/utils.ts and have economics-overview-card.tsx call formatKmQuantityDisplay from @shared/domain/invoice-line-items (drop-in, includes the " km" suffix) or shared formatKm plus " km". Additionally harden KM_TEMPLATE_PATTERN in tests/architecture/km-display-via-helper.test.ts to tolerate nested braces (e.g. /\$\{.*\}\s*km\b/ per line) so future shadows cannot slip past the guard unlisted.

### client-server-drift-10: Appointment end-time/total-duration computed independently at 5+ sites despite shared getEndTime

**Severity:** medium · **Verdikt:** CONFIRMED

**Fundstellen:**
- `client/src/features/time-tracking/components/day-detail-panel.tsx:80-93`
- `client/src/features/appointments/hooks/use-edit-appointment-form.ts:362-367`
- `client/src/features/appointments/hooks/use-edit-appointment-form.ts:474-478`
- `client/src/features/appointments/hooks/use-new-appointment-form.ts:381-385`
- `client/src/pages/document-appointment.tsx:69`
- `server/services/appointments.ts:543-545`
- `shared/domain/appointments.ts:204-216`

**Evidenz (Auditor):** Shared getEndTime/addMinutesToTime exist but are bypassed: day panel has its own getAppointmentEndTime with a different priority chain; use-edit-appointment-form computes end three times with two different mechanisms (`minutesToTimeDisplay((start+total) % 1440)` at 365-367 vs addMinutesToTime at 478/567); use-new-appointment-form is a third copy; document-appointment.tsx re-sums totalServiceMinutes its own hook already computes; server booking derives actualEnd = start + sum(actual||0). Task #595 comment in the edit hook records a previous drift exactly here.

**Vorgeschlagene SSoT:** One shared endTimeFromServices(start, services) in shared/domain/appointments.ts used by form hooks, panel and server service

**Verifikation:** Verified all cited sites exist. Three client sites hand-roll the end-time arithmetic despite importing shared helpers: day-detail-panel.tsx:86-90 is a verbatim inline copy of addMinutesToTime (incl. %24 wrap), and use-edit-appointment-form.ts:365-367 / use-new-appointment-form.ts:383-385 use a second mechanism (timeToMinutes + %1440 + minutesToTimeDisplay) while the edit hook itself calls addMinutesToTime at lines 349/478/567/654 for the same computation. The Task #595 drift comment (lines 443-448) and the tests/appointment-duration-services-sync.test.ts "Marcel-Bug" suite confirm this exact duration/end-time area has drifted before; the server invariant is guard-tested but the client computations are not. However, the auditor overreaches: the day panel's actualEnd→scheduledEnd→computed priority chain answers a different question than shared getEndTime (it includes actuals), and two cited sites (edit hook 478, server appointments.ts:545) already delegate to the shared primitive — their only "duplication" is a one-line reduce over context-specific duration fields (planned vs actual).

**Fix-Skizze:** Replace the hand-rolled arithmetic with existing shared helpers: use addMinutesToTime in use-edit-appointment-form.ts:365-367 and use-new-appointment-form.ts:383-385, and in day-detail-panel.tsx:86-90 (plus formatTimeSlot instead of .slice(0,5)); optionally lift the panel's actualEnd→scheduledEnd→start+services chain into shared/domain/appointments.ts beside getEndTime, and have use-documentation-form expose its totalMinutes so document-appointment.tsx:69 stops re-summing. Do not force the server documentation path (appointments.ts:543-545) or the edit-save path (478) into a shared endTimeFromServices — they already delegate to addMinutesToTime(HHMMSS), select different duration fields (actual vs planned), and are covered by tests/appointment-duration-services-sync.test.ts.


---

**Summe:** 26 CONFIRMED von 30 verifizierten Findings.
