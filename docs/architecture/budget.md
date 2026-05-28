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
  - **Phasen-Schreibung mit explizitem `validFrom` (Task #721):** Wird `PUT /api/budget/:cid/type-settings` mit einem zukunftsdatierten `validFrom` aufgerufen, läuft NICHT der Same-Day-In-Place-Pfad, sondern ein Phasen-Append: Vorgänger (max `validFrom < neuesValidFrom`, der den neuen Stichtag noch überdeckt) wird auf `validTo = neuesValidFrom - 1` geschlossen, die neue Zeile wird zwischen Vorgänger und ggf. existierendem Nachfolger eingeklemmt. Dadurch ergeben N aufeinanderfolgende Aufrufe mit unterschiedlichen `validFrom` auch N historisierte Phasen — egal in welcher Reihenfolge (vorwärts, rückwärts, dazwischen) sie geschrieben werden. Boundary-Konvention: `validTo` ist der letzte gültige Tag inklusive, Phasen überlappen nicht. Idempotenter Read-Only-Audit beim Startup: `server/startup/audit-budget-type-settings-chain.ts` loggt Mehrfach-offene Zeilen, Überlappungen und Lücken — korrigiert nichts (GoBD, Operator-Entscheidung).
- **Startup-Migration `backfill-budget-historization.ts`:** läuft einmalig idempotent, droppt etwaige NICHT-partielle Unique-Indexe auf beiden Tabellen und legt die partiellen Pendants an (`WHERE deleted_at IS NULL` bzw. `WHERE valid_to IS NULL`). Bei dichten Tabellen kann der Index-Build mehrere Sekunden Lock kosten; die DDL ist daher in einer separaten Startup-Phase gekapselt.

## Selbstzahler-Budget-Routing (Task #705, Variante A)

Selbstzahler-Kunden (`billingType='selbstzahler'`) können §45b (Entlastungsbetrag) **nicht** aktivieren — weder als Type-Setting noch über `/initial-budget`. Beide Endpunkte (`PUT /api/budget/:customerId/type-settings` und `POST /api/budget/:customerId/initial-budget`) antworten in diesem Fall mit `409 BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER` und deutscher Fehlermeldung.

Hintergrund: §45b ist eine Pflegekassenleistung; Selbstzahler haben keinen Anspruch. §45a und §39/§42a bleiben für Selbstzahler nicht relevant (kein Pflegegrad-Bezug erforderlich für diese Topftypen im aktuellen UI-Flow). Frontend rendert die §45b-Section in der Budget-Sektion für Selbstzahler gar nicht.

In Phase 1.1 wird diese Regel in einen Shared-Validator (`shared/domain/budget/selbstzahler-rules.ts`) gehoben, den Frontend und Backend gemeinsam konsumieren. Validator-Output: `{ ok, reasons: string[] }` (strukturiert, damit keine doppelten Fehlertexte entstehen).

## API-Vertrag Customer-Create (Task #724, Option B)

`POST /api/admin/customers` legt KEINE Budget-Töpfe automatisch an, wenn der Anlage-Payload keinen `budgets`-Block enthält — auch nicht für Pflegekasse-Kunden ab Pflegegrad 2. Die Initialisierung von §45b / §45a / §39-§42a bleibt Aufgabe der nachgelagerten Endpunkte `POST /api/budget/:customerId/initial-budget` und `PUT /api/budget/:customerId/type-settings`.

Damit API-Konsumenten (Wizard, Import-Skripte, Drittsysteme) das nicht lautlos übersehen, beantwortet der Server jede erfolgreiche Anlage mit zwei strukturierten Marker-Feldern (`CreateCustomerResponse` in `shared/api/customers.ts`):

| Feld | Bedeutung |
|---|---|
| `budgetSetupRequired: boolean` | `true`, wenn der Kunde pflegekassenberechtigt (`pflegekasse_gesetzlich` / `pflegekasse_privat`) mit `pflegegrad >= 2` ist UND der Anlage-Payload keinen `budgets`-Block enthält. Für Selbstzahler und Pflegegrad < 2 immer `false`. |
| `requiredBudgetTypes: string[]` | Liste der noch zu konfigurierenden `BudgetType`-Werte (`entlastungsbetrag_45b`, `umwandlung_45a`, `ersatzpflege_39_42a`). Leer, wenn `budgetSetupRequired = false`. |

Beispiel-Responses (gekürzt):

```jsonc
// PG4 Pflegekasse, Anlage ohne budgets-Block — Folge-Calls nötig
{ "id": 8123, "name": "...", "billingType": "pflegekasse_gesetzlich",
  "budgetSetupRequired": true,
  "requiredBudgetTypes": ["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"] }

// PG4 Pflegekasse, Anlage MIT budgets-Block (Wizard-Pfad)
{ "id": 8124, "...": "...", "budgetSetupRequired": false, "requiredBudgetTypes": [] }

// Selbstzahler oder PG1 — kein Auto-§45b/§45a-Anspruch
{ "id": 8125, "...": "...", "budgetSetupRequired": false, "requiredBudgetTypes": [] }
```

**Warum Option B und nicht Auto-Init?** Wizard-Pfad und API-Pfad teilen sich bereits dieselbe Persistenz (`createCustomerRelatedData`), und der Wizard ruft die Init-Endpunkte explizit als Folgeschritt auf. Eine zusätzliche Auto-Init im Route-Handler hätte zwei Schreibpfade in dieselbe statutorische Konfiguration erzeugt (Wizard schreibt mit individuellen Startwerten/Carryover, API mit Defaults), die später in Edge-Cases gegeneinander gelaufen wären. Der Marker hält die Verantwortung bei genau einer Stelle — den expliziten Budget-Init-Endpunkten — und macht die Vertragslücke trotzdem unübersehbar.

**Reproducer / Regressionsschutz**: `tests/customer-create-budget-setup-marker.test.ts` deckt alle vier `billingType` × `pflegegrad`-Kombinationen ab (Pflegekasse PG4 mit/ohne `budgets`, Pflegekasse PG1, Selbstzahler) sowie den Idempotency-Replay (Marker bleibt auch beim 200-Hit erhalten).

**Idempotency-Replay**: Ein Retry mit gleichem `Idempotency-Key` liefert `200` mit `{...existing, idempotent: true, budgetSetupRequired, requiredBudgetTypes}`. Im Gegensatz zur 201-Erstanlage werden die Marker auf Basis des aktuellen DB-Zustands (`customer_budget_type_settings` mit `validTo IS NULL`) berechnet, nicht des ursprünglichen Payloads. Hat ein Caller zwischen Erstrequest und Retry die Töpfe bereits initialisiert, kippt der Marker korrekt auf `false`.

**Bestandskunden**: `scripts/audit-customers-without-budget-init.ts` (read-only) listet bestehende Pflegekasse-Kunden ab PG 2 ohne aktive Budget-Settings; ein automatischer Backfill ist explizit nicht Teil von #724.

## Budgeting-System

Three-pot Budget-Ledger mit Cascading-Allocation, FIFO für §45b und einem virtuellen Auto-Renewal-Modell für §45b, das monatliche Allocations nicht als DB-Zeilen materialisiert. Concurrent Budget-Consumption wird serialisiert.

### initial-budget-Endpoint (Task #725)

`POST /api/budget/:customerId/initial-budget` legt eine `initial_balance`-Allokation pro Topf an. **Semantik: der Betrag wird genau für den Monat aus `budgetStartDate` gebucht — nicht als Jahresbetrag verteilt.**

**Payload:**

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `budgetType` | `entlastungsbetrag_45b` \| `umwandlung_45a` \| `ersatzpflege_39_42a` | nein (Default `entlastungsbetrag_45b`) | Zieltopf. Für `selbstzahler`-Kunden + §45b → 409 (siehe Selbstzahler-Routing). |
| `currentMonthAmountCents` | `number ≥ 0` | ja | **Monats-Betrag in Cent.** Wird als `initial_balance`-Allokation mit `year/month` aus `budgetStartDate` angelegt. (Der vormalige Alias `currentYearAmountCents` wurde mit Task #731 entfernt — Requests damit erhalten 400.) |
| `carryoverAmountCents` | `number ≥ 0` | nein (Default 0) | Nur für §45b ausgewertet — legt zusätzlich eine `source='carryover'`-Zeile mit `validFrom = YYYY-01-01`, `expiresAt = YYYY-06-30` an. |
| `budgetStartDate` | `YYYY-MM-DD` | ja | Bestimmt `year`/`month` der Monats-Allokation sowie deren `validFrom`. |

Pro Topf legt ein Aufruf maximal eine `initial_balance`-Zeile an:

- **§45b (`entlastungsbetrag_45b`)** — Jahrestopf mit monatlicher Auto-Aufstockung. Der `initial_balance`-Eintrag besetzt den Startmonat (verhindert Doppelzählung mit dem virtuellen Auto-Renewal); spätere Monate stockt `calculateAllocated45b` automatisch auf. `expiresAt = null`. Zusätzlicher `carryoverAmountCents > 0` legt eine `carryover`-Zeile mit Verfall 30.06. an.
- **§45a (`umwandlung_45a`)** — monatliches Budget. `initial_balance` für den Startmonat; Folgemonate sind Sache der Settings/Booking-Pfade. `expiresAt = null`.
- **§39/§42a (`ersatzpflege_39_42a`)** — jährlicher Anspruch. `initial_balance` wird auf den Startmonat gebucht, `expiresAt = YYYY-12-31`. Wer den vollen Jahresbetrag abbilden möchte, übergibt den Jahres-Anspruch als `currentMonthAmountCents` zum Jahresanfang (`budgetStartDate=YYYY-01-01`) — die Zeile gilt dann bis 31.12.

Validierung (Zod): mindestens eines der beiden Amount-Felder muss gesetzt sein. Fehlen beide → 400 `VALIDATION_ERROR`.

**Beispiel-Requests:**

```jsonc
// §45b — Startwert für den laufenden Monat + Restguthaben aus Vorjahr
POST /api/budget/42/initial-budget
{
  "budgetType": "entlastungsbetrag_45b",
  "currentMonthAmountCents": 13100,
  "carryoverAmountCents": 50000,
  "budgetStartDate": "2026-05-15"
}

// §45a — Monatsbudget ab Mai
POST /api/budget/42/initial-budget
{
  "budgetType": "umwandlung_45a",
  "currentMonthAmountCents": 25000,
  "budgetStartDate": "2026-05-15"
}

// §39/§42a — Jahresanspruch zum Jahresanfang
POST /api/budget/42/initial-budget
{
  "budgetType": "ersatzpflege_39_42a",
  "currentMonthAmountCents": 161200,
  "budgetStartDate": "2026-01-01"
}
```

Konsumenten (Wizard, `setup-pending`, Test-Helper, E2E-Smoke) verwenden seit #725 den kanonischen `currentMonthAmountCents`. Der alte Name darf weiter geschickt werden, löst aber eine Deprecation-Warn-Log im Server aus. Drift-Schutz: `tests/budget/initial-budget-endpoint-semantics.test.ts` deckt pro Topf-Typ die gebuchte Zeilen-Position ab und prüft, dass der Alias identisch geroutet wird.

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
