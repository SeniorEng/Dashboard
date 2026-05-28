# Budget-Architektur

Detaillierte Architektur-Entscheidungen und Gotchas zur Budget-Domäne. Übergeordneter Projekt-README: [`../../replit.md`](../../replit.md).

## Aktuelle Konsolidierung (SSoT-Migration)

- **Phase 0 — Inventur** (abgeschlossen): [`../budget-ssot-inventory.md`](../budget-ssot-inventory.md) listet alle Berechnungsstellen pro Kennzahl, dokumentiert 8 Konfliktpunkte und schlägt ein Drei-View-Modell (`BudgetOverviewView`, `BudgetSettingsView`, `BudgetHistoryView`) vor.
- **Beschlüsse Review-Runde** (siehe Inventur-Abschnitt 7): 9/10 Empfehlungen angenommen, #9 (`write_off`-Asymmetrie) per Audit-first statt Regel-first; zwei Querschnitts-Auflagen: (a) neue Services/Views sind pure (kein eigener State/Cache), (b) Validator-Outputs sind strukturiert (`{ ok, reasons[] }`), nicht boolean.
- **Phase 1.1 — `BudgetSettingsView`** (in Arbeit, Read-Pfad fertig): die 4 Settings-Read-Funktionen sind auf eine Read-API `readBudgetTypeSettings(customerId, mode)` mit explizitem Modus (`forDate` / `forEdit` / `withTransition`) konsolidiert. Selbstzahler-Regel liegt als Shared-Validator (`shared/domain/budget-selbstzahler-validator.ts`), §45b-Carryover-Dedup als Shared-Helper (`shared/domain/budget-carryover-dedup.ts`), der `1970-01-01`-Backfill-Sentinel als Shared-Konstante (`shared/domain/budget-settings-sentinel.ts`). Drift-Tests: `tests/equality/budget-settings-read-modes.test.ts` (SSoT === Legacy pro Modus) und `tests/architecture/budget-sentinel-uniqueness.test.ts` (Sentinel-String nur im SSoT-Modul). Write-Pfad/Overview/History folgen in 1.2/1.3.

### Lese-API-Modi (Phase 1.1)

`readBudgetTypeSettings(customerId, mode)` ist der einzige Read-Einstieg in `customer_budget_type_settings`. Die alten Wrapper bleiben bis Phase-1.1-Abschluss als `@deprecated`-Re-Exports bestehen, dürfen aber nicht mehr neu aufgerufen werden.

| Mode | Frage | Verhalten | Heutiger Caller-Typ |
|---|---|---|---|
| `{ kind: "forDate", asOfDate }` | „Welche Topf-Konfig galt an Datum X?" | Filtert `validFrom <= asOfDate AND (validTo IS NULL OR validTo >= asOfDate)`, gibt pro `budget_type` die aktive Zeile zurück. | Booking-Pfad, Cap-Berechnung, Stats-as-of. |
| `{ kind: "forEdit" }` | „Was würde der Edit-Dialog dem User als Latest-Intent zeigen?" | Pro `budget_type` die Zeile mit dem höchsten `validFrom` (auch in der Zukunft). | Settings-Dialog initial load. |
| `{ kind: "withTransition" }` | „Latest-Intent + heute effektive Zeile in einer Antwort." | Wie `forEdit`, plus eine zweite Spalte `effectiveToday` mit dem `forDate(today)`-Treffer. UI maskiert den Übergangsbalken daraus. | Settings-Dialog mit Transition-Hint. |

Regel: neue Caller wählen einen Modus explizit; Read-Pfad und Write-Pfad teilen sich denselben Eintrag — keine parallele Inline-Query mehr.
- **Phase 1.2 — `BudgetOverviewView`** (geplant, nach 1.1): konsolidiert §45b-/§45a-/§39-Cap-Pfade auf `computeCapSlot`, hebt DTO nach `shared/api/budget.ts`, teilt Cost-Estimate-Route auf.
- **Phase 1.3 — `BudgetHistoryView`** (geplant, nach 1.2): aggregiert Allocations/Transactions/Audit-Reads.
- **Phase 2** — `BudgetForecastView` (Blocker: stabiler Forecast aus #704), `customer_budgets`-Tabelle endgültig abschalten, Stats-V2 auf Batch-Read über OverviewView.

## Query-Invalidation (Budget-Spezifika)

Allgemeine Konvention zu `invalidateRelated()` siehe [`replit.md → Architecture decisions → Strict Data Consistency`](../../replit.md#architecture-decisions).

Zusätzlich für Budget-Daten:
- Query-Keys folgen dem Schema `[<domain-key>, customerId, ...]` und werden zentral in `DOMAIN_QUERY_KEYS.budget` registriert (Discipline-Test prüft das).
- `invalidateRelated(qc, "budget", { customerId })` scopt die Invalidierung auf einen Kunden (gegen Cross-Customer-Over-Invalidation).
- Budget-Mutationen `await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" })` vor dem UI-Schließen, damit Folge-Aktionen (z.B. direkt anschließendes „Termin anlegen") nicht auf einer veralteten BudgetSummary basieren.

## GoBD-Historisierung (Budget-Tabellen)

- **`budget_allocations` — kein Resurrect:** Soft-gelöschte Zeilen werden niemals wiederbelebt (`deletedAt = null`). `upsertInitialBalanceAllocation` und `upsertCarryoverAllocation` legen stattdessen eine neue Zeile an und schreiben einen `budget_allocation_resurrected`-Audit-Eintrag. Der partielle UNIQUE-Index `WHERE deleted_at IS NULL` macht den Ersatz-Insert kollisionsfrei.
- **`customer_budget_type_settings` — append-only:** `upsertBudgetTypeSettings` schließt die alte offene Zeile (`validTo = heute`) und legt eine neue mit `validFrom = heute+1` an (Erstanlage: `validFrom = heute`). Read-Pfade (`getActiveBudgetTypeSettings`) filtern nach `transactionDate`, sodass historische Buchungen die damals gültige Konfiguration sehen. Pro Transition wird ein `budget_type_settings_transition`-Audit-Log geschrieben (Task #440).
- **Startup-Migration `backfill-budget-historization.ts`:** läuft einmalig idempotent, droppt etwaige NICHT-partielle Unique-Indexe auf beiden Tabellen und legt die partiellen Pendants an (`WHERE deleted_at IS NULL` bzw. `WHERE valid_to IS NULL`). Bei dichten Tabellen kann der Index-Build mehrere Sekunden Lock kosten; die DDL ist daher in einer separaten Startup-Phase gekapselt.

## Selbstzahler-Budget-Routing (Task #705, Variante A)

Selbstzahler-Kunden (`billingType='selbstzahler'`) können §45b (Entlastungsbetrag) **nicht** aktivieren — weder als Type-Setting noch über `/initial-budget`. Beide Endpunkte (`PUT /api/budget/:customerId/type-settings` und `POST /api/budget/:customerId/initial-budget`) antworten in diesem Fall mit `409 BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER` und deutscher Fehlermeldung.

Hintergrund: §45b ist eine Pflegekassenleistung; Selbstzahler haben keinen Anspruch. §45a und §39/§42a bleiben für Selbstzahler nicht relevant (kein Pflegegrad-Bezug erforderlich für diese Topftypen im aktuellen UI-Flow). Frontend rendert die §45b-Section in der Budget-Sektion für Selbstzahler gar nicht.

In Phase 1.1 wird diese Regel in einen Shared-Validator (`shared/domain/budget/selbstzahler-rules.ts`) gehoben, den Frontend und Backend gemeinsam konsumieren. Validator-Output: `{ ok, reasons: string[] }` (strukturiert, damit keine doppelten Fehlertexte entstehen).

## Budgeting-System

Three-pot Budget-Ledger mit Cascading-Allocation, FIFO für §45b und einem virtuellen Auto-Renewal-Modell für §45b, das monatliche Allocations nicht als DB-Zeilen materialisiert. Concurrent Budget-Consumption wird serialisiert.

### §45b Startwert vs. Restguthaben aus Vorjahr (Task #670)

Im UI getrennt:
- **„Startwert laufendes Jahr"** (`source='initial_balance'`, läuft nicht ab)
- **„Restguthaben aus Vorjahr"** (`source='carryover'`, `validFrom = YYYY-01-01`, `expiresAt = YYYY-06-30` gem. §45b SGB XI Abs. 3)

Backend: `POST /api/budget/:customerId/carryover/entlastungsbetrag_45b` mit `{ amountCents, sourceYear }`. `upsertCarryoverAllocation` aktualisiert die bestehende Zeile pro Quelljahr in-place und macht — analog zu `upsertInitialBalanceAllocation` — KEINEN Resurrect soft-gelöschter Zeilen (Audit: `budget_allocation_resurrected`).

Quelljahr-Dedup teilt sich denselben Schlüssel (`existingCarryoverYears.has(targetYear)`) mit dem Auto-Carryover-Pfad `ensureYearlyCarryover45b`, daher kollidieren manuelle und automatische Übertragsanlage nicht. Delete teilt sich `DELETE /:customerId/initial-balance/:allocationId` (handlet beide Quellen).

Carryover ist nur für §45b verfügbar — Server validiert, UI rendert die Sektion sonst gar nicht.

### §45b „Unser Anteil" pro Kunde (Task #603)

`customer_budget_type_settings.monthly_limit_cents` ist für §45b ein per-Kunde konfigurierbarer Monats-Anteil (€/Monat) — er reduziert die monatliche Aufstockung des Jahrestopfs in `calculateAllocated45b` (Variante A), wirkt aber **nicht** als harter Buchungs-Cap (cap-calculator §45b-Branch bleibt `Infinity`). Leer = gesetzliche Vollausschöpfung 131 €/Monat.

Server validiert Werte > 131 € mit deutscher Fehlermeldung; `clampToStatutoryMax` greift als Safety-Net. Per-Monat-Lookup über die historisierten Zeilen (`validFrom`/`validTo`, Stichtag = Mitte-des-Monats) garantiert, dass rückwirkende Buchungen den damals gültigen Anteil sehen.

Die Startup-Migration `clear-45b-monthly-limits` ist No-Op, damit Re-Deploys konfigurierte Werte nicht wegwerfen.
