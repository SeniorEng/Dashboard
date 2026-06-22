# Budget — SSoT-Vollständigkeits-Audit

Read-only Bestandsaufnahme: Welche Code-Stellen beantworten die **vier
fachlichen Budget-Fragen**, ob sie eine **Single Source of Truth (SSoT)** oder
hand-gerollt sind, und welche **Architektur-Wächter** jede Frage gegen Drift
absichern. Dieses Dokument ändert kein Verhalten und konsolidiert nichts — es
dokumentiert den Ist-Zustand und verankert die Guards.

> Stand der Sondierung: Task #1390. Beträge/Regeln:
> [`docs/budget-legal-spec.md`](budget-legal-spec.md). Architektur-Detail:
> [`docs/architecture/budget.md`](architecture/budget.md). Symbol-Inventur:
> [`docs/budget-ssot-inventory.md`](budget-ssot-inventory.md).

---

## Die vier Fragen — Überblick

| # | Fachliche Frage | SSoT | Klassifikation | Guard |
|---|---|---|---|---|
| Q1 | „Verfügbar?" (wieviel ist frei) | `readUnifiedBudgetAvailability` → `computeCapSlot`/`computeCapRemaining` (Cap-Töpfe) + `netAvailable45bAt`/`computeNetAvailable45b` (§45b) | **SSoT** | `ssot-imports.test.ts` A1 + `budget-single-reader.test.ts` (I1/§45b) |
| Q2 | „Verteilung über Töpfe?" (Consumption/Cascade) | `planCascade` | **SSoT** | `ssot-imports.test.ts` A4 |
| Q3 | „Welche Töpfe default-aktiv?" (Aktivierung) | `effectiveDefaultPots` → `defaultStatutoryPotEnabled` (Konstante `DEFAULT_BUDGET_POT_ORDER` modul-privat) | **SSoT** | `budget-default-pots-ssot.test.ts` |
| Q4 | „Privatanteil erlaubt?" (Privat-Entscheidung) | `isPrivatePaymentAllowed` / `isSelbstzahlerBillingType` | **SSoT** | `ssot-imports.test.ts` A5 |

Alle vier Fragen sind heute durch je mindestens eine **build-brechende
Architektur-Fitness-Function** abgesichert (CI-Pflicht-Gate). Die Guards sind
PUR (Detektor-Funktion + Negativ-Test, der die bewusste Verletzung beweist).

---

## Q1 — „Verfügbar?" (Verfügbarkeits-/Cap-Reader)

**SSoT:** `readUnifiedBudgetAvailability`
([`server/storage/budget/unified-reader.ts`](../server/storage/budget/unified-reader.ts))
ist DER eine Verfügbarkeits-Reader. Er delegiert:

- **Cap-Töpfe (§45a, §39/§42a):** pure Cap-Math in
  [`shared/domain/budget/cap-math.ts`](../shared/domain/budget/cap-math.ts)
  (`computeCapSlot`/`computeCapRemaining`), Konsum über
  `.netUsedInWindowCents`.
- **§45b:** eigene Jahres-Verfügbarkeits-Mathematik
  (`max(0, allocated − holds − consumedNet)`, inkl. #1306/#1340-Carryover-
  Exklusion und Floor) in
  [`shared/domain/budget/net-available-45b.ts`](../shared/domain/budget/net-available-45b.ts)
  (`computeNetAvailable45b`), DB-Reader
  [`server/storage/budget/net-available-45b.ts`](../server/storage/budget/net-available-45b.ts)
  (`netAvailable45bAt`).

**Date-Pinning:** alle Reader sind `asOfDate`-/`forDate`-gebunden; die §45b-
Forecast-Vorausschau projiziert pro Monatsende via
`netAvailable45bAt({ projectFuture: true, holds: "ignore" })`. Verbleibender
Legacy-Fallback `summary-queries.ts` bleibt bis Phase 6 als Shadow-Soak-Reader
(dokumentiert in der Single-Reader-Allowlist).

**Klassifikation:** SSoT (ein Reader, delegiert; keine Parallel-Mathematik).

**Guards:**
- `ssot-imports.test.ts` **A1** — `computeCapSlot`/`computeCapRemaining` nur
  Budget-intern importierbar.
- `budget-single-reader.test.ts` — `.netUsedInWindowCents`-Konsum,
  `netAvailable45bAt`-Aufruf und `computeNetAvailable45b`-Aufruf je auf eine
  Allowlist beschränkt; Forecast darf die #1340-Exklusion nicht selbst
  zusammenrechnen.
- `calculations-in-shared.test.ts` — `calculate*`/`compute*`-Hotspots (inkl.
  `*45b`) MÜSSEN in `shared/domain/` wohnen.

## Q2 — „Verteilung über Töpfe?" (Consumption/Cascade)

**SSoT:** `planCascade`
([`shared/domain/budget/plan-cascade.ts`](../shared/domain/budget/plan-cascade.ts))
ist die EINE pure Verteilungs-Funktion: sie schichtet einen Betrag
deterministisch über die statutorischen Töpfe (Cascading-Allocation, FIFO für
§45b) plus den terminalen Selbstzahler-/Privat-Topf. Die Consumption-Engine ist
in Read- (Precompute) + Write-Phase getrennt; beide rufen dieselbe `planCascade`
(byte-identisch, da FIFO-Verfügbarkeit pro `budgetType` unabhängig ist).

**Produktive Aufrufer (Allowlist):**
- `shared/domain/budget/plan-cascade.ts` — Definition.
- `server/storage/budget/consumption-engine.ts` — Buchung.
- `server/storage/budget/reservation-storage.ts` — Reservierung/Hold.
- `server/services/invoice-data.ts` — netto-null Re-Derivation der Rechnung.

**Date-Pinning:** Cascade selbst ist pure Arithmetik (kein Datum); die ihr
zugeführten Topf-Verfügbarkeiten stammen aus dem `asOfDate`-gebundenen Q1-Reader.

**Klassifikation:** SSoT.

**Guard:** `ssot-imports.test.ts` **A4** — `planCascade(` darf nur in der
Allowlist aufgerufen werden (reiner Import triggert nicht).

## Q3 — „Welche Töpfe default-aktiv?" (Aktivierung)

**SSoT:** `effectiveDefaultPots(customer)`
([`shared/domain/budgets.ts`](../shared/domain/budgets.ts)) ist der
anspruchs-gegatete Resolver. Er kombiniert die modul-private Roh-Default-Reihung
`DEFAULT_BUDGET_POT_ORDER` (§45b an, §45a/§39 aus) mit dem Selbstzahler-Gate
`defaultStatutoryPotEnabled` → `validateSelbstzahlerBudget`
([`shared/domain/budget-selbstzahler-validator.ts`](../shared/domain/budget-selbstzahler-validator.ts)).
§45b ist als einziger Topf default-aktiv — aber nur für
anspruchsberechtigte (Nicht-Selbstzahler-)Kunden.

**Date-Pinning:** Aktivierungs-Default ist zustands-/zeitunabhängig (gilt, wenn
KEINE persistierte `customer_budget_type_settings`-Zeile existiert); die
zeit­liche Versionierung der tatsächlichen Settings (forDate vs. forEdit) ist in
der Architektur-Doku beschrieben und nicht Teil dieser Frage.

**Klassifikation:** SSoT (Resolver gegatet; Roh-Konstante modul-privat).

**Guard:** `budget-default-pots-ssot.test.ts` — `DEFAULT_BUDGET_POT_ORDER` ist
modul-privat in `shared/domain/budgets.ts`; jeder Import außerhalb ist ein
Verstoß (korrekter Einstieg: `effectiveDefaultPots`).

## Q4 — „Privatanteil erlaubt?" (Privat-Entscheidung)

**SSoT:** `isPrivatePaymentAllowed({ billingType, acceptsPrivatePayment })`
([`shared/domain/budget-selbstzahler-validator.ts`](../shared/domain/budget-selbstzahler-validator.ts))
ist die EINE Definition der Formel
`acceptsPrivatePayment || billingType === "selbstzahler"`. Alle Buchungs-/
Rebook-/Reservierungs-/Import-/Rechnungssplit-Pfade importieren sie:
`consumption-engine.ts`, `rebook-storage.ts`, `reservation-storage.ts`,
`appointment-import.ts`, `invoice-calc.ts` (+ der read-only Reconcile-Script).
Der Schreib-Block für Selbstzahler-auf-gesetzliche-Töpfe ist die Schwester-SSoT
`validateSelbstzahlerBudget`.

**Date-Pinning:** zustands-/zeitunabhängig (reine Kunden-Stammdaten-Frage:
`customers.billingType` + `customers.acceptsPrivatePayment`).

**Klassifikation:** SSoT.

**Guard:** `ssot-imports.test.ts` **A5** — keine hand-gerollte
`acceptsPrivatePayment || selbstzahler`-Formel außerhalb der SSoT-Datei
(Detektor erkennt die `||`-Verknüpfung beider Token; reiner SSoT-Aufruf
triggert nicht).

---

## Guard-Matrix (Datei → abgedeckte Frage)

| Guard-Datei | Frage(n) | Mechanik |
|---|---|---|
| `tests/architecture/ssot-imports.test.ts` | Q1 (A1), Q2 (A4), Q4 (A5) | Import-/Aufruf-/Formel-Rand |
| `tests/architecture/budget-single-reader.test.ts` | Q1 | Konsum-/Aufruf-Allowlist (Cap + §45b) |
| `tests/architecture/budget-default-pots-ssot.test.ts` | Q3 | modul-private Konstante |
| `tests/architecture/calculations-in-shared.test.ts` | Q1 (Hotspot-Mathe) | `compute*/calculate*` in `shared/domain/` |
| `tests/architecture/budget-legal-spec-conformance.test.ts` | Beträge (R-45B/45A/39) | Konstante == Spec |

**Fazit:** Jede der vier Fragen ist durch genau eine SSoT beantwortet und durch
mindestens einen build-brechenden Architektur-Wächter abgesichert. Offene
Konsolidierungen (z. B. Phase-6-Entfernung des `summary-queries`-Shadow-Readers)
sind in [`docs/architecture/budget.md`](architecture/budget.md) verortet und
liegen außerhalb dieses read-only Audits.
