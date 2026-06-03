# Budget-Architektur

Detaillierte Architektur-Entscheidungen und Gotchas zur Budget-Domäne. Übergeordneter Projekt-README: [`../../replit.md`](../../replit.md).

## Greenfield-Ziel-Architektur (North Star)

> **Verbindliche Ziel-Architektur:** [`./budget-greenfield-architecture.md`](./budget-greenfield-architecture.md)
> ist die durable Engineering-Referenz für den Budget-Endzustand (Drei-Tabellen-Modell:
> Allocations / operative Reservierungen / GoBD-immutabler Finanz-Ledger). Die vier
> hart-zu-ändernden Phase-0-Entscheidungen sind in den ADRs unter
> [`./adr/`](./adr/) festgeschrieben:
> [ADR-0001 Reservation/Finanz-Split](./adr/0001-reservation-financial-split.md),
> [ADR-0002 Reservierungs-Historie](./adr/0002-reservation-history-model.md),
> [ADR-0003 Capture-Transaktions-Grenze](./adr/0003-capture-transaction-boundary.md),
> [ADR-0004 Zwei-Tabellen-Non-Negativity-Guard](./adr/0004-two-table-non-negativity-guard.md).
> Die GoBD-Verfahrensdokumentation ist in
> [`./budget-verfahrensdokumentation.md`](./budget-verfahrensdokumentation.md) geseedet
> (Finalisierung in Phase 6). Die unten beschriebene SSoT-Konsolidierung ist der
> Migrationspfad dorthin.

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
- **Phase 2** — `BudgetForecastView` (Blocker: stabiler Forecast aus #704), §45b-Materialisierung (virtuelles Auto-Renewal → monatliche `budget_allocations`-Zeilen), `customer_budgets`-Tabelle physisch droppen (DDL), Stats-V2 auf Batch-Read über OverviewView.

### Phase 6 — Endzustand (abgeschlossen)

Phase 6 hat die SSoT-Konsolidierung abgeschlossen (NICHT den physischen Reservierungs-/Finanz-Ledger-Split des North Star — der bleibt Ziel-Architektur):

- **Eine `Available`-Lese-Quelle:** Alle Serving-Pfade (Overview, Kostenschätzung, Termin-Anlage, Termin-Serien-Verlängerung) lesen ausschließlich über den unified Reader (`getAvailableForDate` / `readUnifiedBudgetAvailability`). Die alten Summary-Reader (`getBudgetSummary*`, `getAllBudgetSummaries`) sind aus dem Serving entfernt und nur noch Shadow-/Equality-Baseline.
- **`customer_budgets`-Reads & -Writes abgeschaltet** (seit Task #728, hier verifiziert + per Architektur-Test `tests/architecture/no-customer-budgets-reads.test.ts` verriegelt). Physischer Tabellen-Drop bleibt Phase 2.
- **Route→Storage-Folds:** keine direkte `db.*`-Choreographie mehr in den Budget-Routen (`server/routes/budget.ts`, `server/routes/admin/customers/budgets.ts`); Schreib-/Transaktionslogik liegt im Storage-Layer.
- **Rechnungs-Split pro Topf** über `invoices.billing_run_id`, Σ-Invariante per Equality-Test abgesichert.
- **Akzeptierte §45b-Shadow-Divergenz:** Der §45b-Monatsbetrag bleibt virtuell (`calculateAllocated45b`); der Shadow-Soak zeigt darum eine erwartete, designgewollte Differenz Legacy↔unified (§45a/§39 = Δ0). Sie wird NICHT durch Angleichen der Legacy-Mathematik „repariert", sondern erst mit der §45b-Materialisierung (Phase 2) aufgelöst. Details: [`budget-verfahrensdokumentation.md → Ist-Zustand nach Phase 6`](./budget-verfahrensdokumentation.md).

### Hard-Block-Scharfschaltung in Produktion (Task #953)

Der Overdraft-Hard-Block (Termin-Anlage, die einen nicht-privat-zahlenden Kunden über sein Budget zieht → `422 BUDGET_HARD_BLOCK`) ist hinter dem Feature-Flag `BUDGET_HARD_HOLDS` gegated (`hardHoldsEnabled()` in `server/storage/budget/reservation-storage.ts`, an = `"1"`/`"true"`). Das Flag ist über die Replit-Env-Scopes in `.replit` gesetzt: `[userenv.development]` **und** `[userenv.production]` = `"1"` (gepflegt über die Secrets-/Env-Verwaltung, nicht durch direktes `.replit`-Editieren).

- **Regressionsschutz:** `tests/architecture/budget-hard-holds-production-enabled.test.ts` (reiner `.replit`-Read, `unit`-Project) failed, wenn weder ein produktions- noch ein shared-Scope das Flag scharf schaltet — so kann die Prod-Konfiguration nicht lautlos auf OFF zurückdriften.
- **Laufzeit-Sichtbarkeit:** `/api/health → budgetHardHolds.enabled` weist den effektiven Zustand der laufenden Instanz aus; der Startup (`server/index.ts`) loggt in Produktion zusätzlich laut, falls das Flag fehlt.
- **Testserver bleibt Legacy:** Der Ephemeral-DB-Orchestrator (`scripts/with-ephemeral-db.ts`) entfernt `BUDGET_HARD_HOLDS` aus dem Test-Server-Env, damit `tests/budget/hard-holds-engine.test.ts` die Engine weiter direkt gegen die DB treibt (HTTP-Pfad legacy). In CI ist das Flag nie gesetzt.
- **Publish-Hinweis:** Die Env-Änderung greift erst nach einem Re-Publish des Deployments (aus der Main-Version, nach Merge dieses Tasks).

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
- **DB-seitige Unveränderbarkeit per Trigger (Task #828):** Über die App-Konventionen hinaus erzwingt die idempotente Startup-Migration `server/startup/ensure-gobd-table-immutability.ts` die Historisierungs-Invarianten technisch per raising BEFORE-Trigger (analog `audit_log`, Task #824) — eine verbotene direkte Mutation schlägt mit `restrict_violation` fehl statt still durchzugehen. Geschützt: `budget_allocations` (kein Resurrect `deleted_at` NOT NULL→NULL, kein Hard-Delete, kein TRUNCATE), `customer_budget_type_settings` (kein Hard-Delete, kein TRUNCATE; UPDATE für den Phasen-Append/In-Place-Pfad bleibt erlaubt), `invoices` (kein Hard-Delete finalisierter Rechnungen `status<>'entwurf'`, kein TRUNCATE; UPDATE für Status/Qonto/PDF-Cache bleibt erlaubt) und `invoice_line_items` (kein UPDATE/DELETE von Positionen finalisierter Rechnungen, kein TRUNCATE). Legitime Hard-Delete-/Cleanup-Pfade (Kunden-Merge `duplicates.ts`, Test-Daten-Purge `test-data-cleanup.ts`/`cleanup-test-data.ts`, `migrate-budget-sources.ts`) setzen transaktions-lokal `SET LOCAL app.allow_gobd_mutation = 'on'` und passieren die Trigger nur für genau diese Transaktion; in Produktion wird das GUC nie gesetzt. Tests: `tests/gobd-table-immutability.test.ts`.

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

### §45b Anker am Pflegegrad-Beginn (Task #856) + Onboarding-Baseline (Task #860)

Der §45b-Entlastungsbetrag wächst ab dem **Pflegegrad-Beginn** (frühster Eintrag in der Care-Level-History), nicht ab dem Vertragsbeginn. So sieht ein Kunde mit Pflegegrad seit März, aber Vertrag erst ab Juni, die ungenutzten März-/April-/Mai-Monate im Budgets-Tab statt „Noch keine Zuweisungen vorhanden".

**Onboarding-Baseline (Task #860) — Vorjahr gilt als aufgebraucht:** Beim Anlegen eines Kunden gibt es keine belastbare Datengrundlage dafür, wie viel des §45b-Entlastungsbetrags im **Vorjahr** schon verbraucht wurde. Die fachliche Default-Annahme lautet daher: **das Vorjahr ist vollständig aufgebraucht** (Default-Übertrag 0 €), und das **laufende Jahr** stockt ab dem Anker (frühestens 1.1. des laufenden Jahres) voll auf. Ein tatsächlich verbliebenes Vorjahres-Restguthaben trägt der Operator manuell als Übertrag ein (Wizard-Feld „Übertrag (€)", Default „0"); es bekommt `validFrom = 1.1.` / `expiresAt = 30.06.` des laufenden Jahres und verfällt danach mit sichtbarem Write-off. Es gibt **keinen** automatisch materialisierten Vorjahres-Übertrag mehr.

**Anker-Auflösung — der gesamte §45b-RUNTIME-Pfad bodet auf das laufende Jahr** (`floorAutoAnchor45bToCurrentYear`, in `shared/domain/budgets.ts`):

- **§45b-Lesepfad + Carryover-Anlage + `/initial-budget`-Write** (`calculateAllocated45b` / `ensureYearlyCarryover45b` in `server/storage/budget/allocation-storage.ts`, §45b-Block in `server/routes/budget.ts`) boden einen abgeleiteten Anker (`budget_start_date_origin = 'derived_pflegegrad'`) auf den **1.1. des laufenden Jahres** mit `floorAutoAnchor45bToCurrentYear`. Der Pflegegrad-Beginn zählt also nur innerhalb des laufenden Jahres (ein Datum davor wird auf den Jahresanfang angehoben), ein zukünftiges Datum bleibt unverändert. Bei `'manual'` (oder NULL = Altbestand) bleibt der Anker ungebodet — **manuell gewinnt immer**. **Warum:** Ein automatischer Vorjahres-Übertrag (bis 12 × 131 € = 1.572 €) hat beim Onboarding keine fachliche Grundlage; das Boden auf das laufende Jahr verhindert ihn überall einheitlich (vorher tauchte z.B. nach dem Löschen einer Carryover-Zeile sofort wieder ein voller Vorjahres-Übertrag auf — E2E-Regression `§45b-Carryover — Löschen … persistiert nach Reload`).
- **`clampDerived45bAnchor` / `earliest45bRelevantAnchor`** erlauben weiterhin das **rechtliche §45b-Fenster** (laufendes Jahr + Vorjahr, dessen Carryover bis 30.06. gültig ist). Seit Task #860 werden sie im Runtime-Pfad **NICHT mehr** verwendet — nur noch vom einmaligen Korrektur-Skript `server/scripts/fix-customer-45b-anchor.ts`, falls gezielt eine Daten-Korrektur im Vorjahres-Fenster nötig wird. Helfer + Unit-Tests bleiben erhalten (`tests/unit/budget-45b-anchor.test.ts`).

Beide Lesepfad-Blöcke (`calculateAllocated45b` und `ensureYearlyCarryover45b`) und der `/initial-budget`-Write müssen denselben Anker (gleiches Boden auf das laufende Jahr) verwenden, sonst driften die angezeigte Summe und die tatsächlich angelegten Carryover-Zeilen auseinander. Die manuell gesetzte `budgetStartDate` gewinnt immer vor dem abgeleiteten Pflegegrad-Anker.

**FORWARD-ONLY (keine Datenmigration):** Bestehende `budget_allocations`-Zeilen werden durch Task #860 NICHT umgeschrieben; nur künftige Recomputes lesen den gebodeten Anker. Das **Read-only-Sicherheitsnetz** `server/scripts/verify-45b-anchor-change.ts` listet vor/nach der Umstellung jeden Kunden mit abgeleitetem Anker, dessen berechnete §45b-Verfügbarkeit sich verschiebt (alt `clampDerived45bAnchor` vs. neu `floorAutoAnchor45bToCurrentYear`), inkl. der Differenz der bis heute aufgestockten Monate × 131 €. `--all` zeigt zusätzlich unveränderte Anker.

**Shared-Preferences-Schreibdisziplin (`budget_preferences.budget_start_date` + `budget_start_date_origin`):** Das Feld ist **kunden-weit** und wird von ALLEN Töpfen als primärer Anker gelesen. Der Wizard postet `POST /initial-budget` nacheinander für §45b → §45a → §39 mit demselben (ungekappten) `pflegegradSeit`. **Alle drei Calls** schreiben denselben **RAW**-Anker (`rawBudgetStartDate`, ungekappt) mit `budget_start_date_origin = 'derived_pflegegrad'` in die Preferences — die Reihenfolge ist damit irrelevant. Das Boden auf das laufende Jahr passiert ausschließlich im **§45b-Pfad** (origin-aware, s.o.), NICHT durch eine gekappte Preferences-Zeile. So lesen §45a/§39 weiterhin den ungekappten Pflegegrad-Beginn (unverändertes Verhalten), während §45b denselben Anker beim Lesen auf das laufende Jahr bodet. Setzt ein Admin den Start explizit via `PUT /preferences`, wird `origin = 'manual'` markiert → §45b bodet NICHT mehr (Szenario INT-13: historische `budgetStartDate` 2024 behält ihren Vorjahres-Carryover). Altbestand vor #856 hat `origin = NULL` und wird bewusst wie `'manual'` behandelt (kein stilles Umrechnen bestehender Budgets; betroffene Altkunden werden gezielt per Korrektur-Skript migriert). Idempotente Spalten-Migration: `server/startup/ensure-budget-start-date-origin.ts`.

## Storno / Reversal — Service-Cent-Spiegel-Konvention (Task #754)

Jede Reversal-TX SPIEGELT die Service-Cent-, Minuten- und Kilometer-Spalten
ihrer korrespondierenden Consumption-TX **vorzeichen-invertiert**:

| Spalte                       | Consumption        | Reversal             |
|------------------------------|--------------------|----------------------|
| `amountCents`                | `-X` (negativ)     | `+X` (positiv)       |
| `hauswirtschaftCents`        | `+a` (positiv)     | `-a` (negativ)       |
| `alltagsbegleitungCents`     | `+b`               | `-b`                 |
| `travelCents`                | `+c`               | `-c`                 |
| `customerKilometersCents`    | `+d`               | `-d`                 |
| `hauswirtschaftMinutes`      | `+m1`              | `-m1`                |
| `alltagsbegleitungMinutes`   | `+m2`              | `-m2`                |
| `travelKilometers`           | `+k1`              | `-k1`                |
| `customerKilometers`         | `+k2`              | `-k2`                |

**Invariante**: `Σ <spalte>` über `{consumption + reversal}` je `appointmentId`
= 0 für alle Service-Spalten. Lexware-Export, §45b-Anzeige und Statistik
summieren diese Spalten direkt — stornierte Termine ergeben damit netto 0
gebuchte Hauswirtschaft / Alltagsbegleitung / Reisekosten / Customer-km.

**Aufrufer-Pflicht**: jede neue Code-Stelle, die eine Reversal-TX einfügt,
muss die Service-Spalten aus der Original-Consumption übernehmen und negieren.
Die drei produktiven Pfade sind:
- `reverseBudgetTransaction` in `server/storage/budget/transaction-storage.ts`
- `rebookSingleTransaction` in `server/storage/budget/rebook-storage.ts`
- `rebookDisabledBudgetTransactions` (Cascade-Loop) ebenda

Drift-Detektor: `tests/equality/storno-summe-null.test.ts`
Konventions-Test: `tests/budget/reversal-service-cents-mirror.test.ts`

**GoBD / Bestandsdaten**: Reversal-Tx, die vor Task #754 mit `NULL`-Service-
Spalten geschrieben wurden, werden NICHT in-place korrigiert. Falls bei
Audit Produktivdaten betroffen, separater Korrektur-Task: Storno der
beschädigten Reversal + Neuanlage mit korrekten Spiegel-Werten.

## PUT `/type-settings` ohne `validFrom` auf Zukunfts-Zeile (BUG-13 / Task #754)

Liegt für einen Topf eine offene Zeile mit `validFrom > today` vor und sendet
der Aufrufer einen PUT **ohne** explizites `validFrom`, wird die bestehende
Zeile auf `validFrom = today` vorgezogen (In-Place-Update mit den neuen
Werten). Begründung: solange `validFrom > today`, war die Zeile noch nie
"in Kraft" — keine Buchung kann sie referenziert haben (Konsumtions-Lookups
nutzen `validFrom <= transactionDate`). Pull-Forward macht die neu
gespeicherten Werte (Limit, enabled, Priorität) im laufenden Monat sofort
sichtbar und damit für `monthly_auto` greifbar.

Explizites `validFrom` im Payload hat weiterhin Vorrang und triggert wie
zuvor entweder den Phasen-Append-Pfad (Zukunftsdatum) oder die
Transitions-/In-Place-Logik (heutiges/gestriges Datum).

Regressions-Test: `tests/budget/type-settings-future-row-overwrite.test.ts`

## Rechnungs-Split pro Topf (Task #759, Variant C)

Ab Task #759 wird ein Abrechnungslauf, der Termin-Anteile aus **mehreren**
Budget-Töpfen verbraucht hat, in **N Rechnungen** aufgeteilt — eine pro
`budget_type` (`entlastungsbetrag_45b`, `umwandlung_45a`,
`ersatzpflege_39_42a`) plus optional eine Selbstzahler-Rechnung für den
privaten Rest. Hat ein Lauf nur einen einzigen Topf, bleibt es bei der
Bestand-Single-Invoice (kein Verhaltenswechsel, kein Bestand-Rewrite).

### Pot → Empfänger

`resolveBudgetRecipient(customerId, budgetType, asOf)`
(`server/storage/budget-recipients.ts`) löst pro Topf den Rechnungs-
Empfänger auf:

1. Append-only `customer_budget_recipients`-Override für diesen Kunden +
   Topf, gültig zum Termin-Datum.
2. Andernfalls: Kassen-Töpfe → aktueller `customerInsuranceHistory`-Eintrag
   (Pflegekasse), Selbstzahler-Pot → Kunden-Adresse.
3. `rechnungAnKunde=true` zwingt alle Kassen-Empfänger zurück auf die
   Kunden-Adresse (Kostenerstattungsverfahren).

### `billingRunId` (uuid)

Jeder Multi-Pot-Lauf bekommt eine `randomUUID()`, die als `billing_run_id`
auf **allen** zugehörigen Rechnungen gespeichert wird. Die UI rendert ein
„Topf-Gruppe"-Badge, sobald `billingRunId` gesetzt ist. Single-Pot-Läufe
schreiben `billing_run_id = NULL`.

### Cascade-Storno

`PATCH /api/billing/:id/status` akzeptiert `{ status: "storniert",
cascadeRun: true }`. Ist die Quelle Teil einer `billingRunId`-Gruppe,
storniert die innere Transaktion ALLE aktiven Geschwister (Status ≠
`storniert`, nicht selbst Stornorechnung) im selben `withAudit`-Run.
Pro Geschwister wird eine eigene Storno-Rechnung mit eigener Nummer
angelegt, das Budget-Reversal läuft pro `appointmentId` wie zuvor, und
alle Storno-PDFs werden im Hintergrund persistiert.

### Drift-Garantie

Die Verteilung selbst lebt pure in
`shared/domain/budget-invoice-split.ts` (`splitLineItemsAcrossPots`).
Largest-Remainder mit deterministischem Pot-Tiebreak (`POT_ORDER`)
garantiert: Σ aller Pot-Anteile = Σ Line-Item-Beträge — pro Termin und
über den ganzen Lauf, ohne Cent-Drift. Detektor:
`tests/equality/invoice-per-pot-arithmetic.test.ts`.

### GoBD

Bestand wird nicht angetastet — alte Single-Pot-Rechnungen behalten
`budget_type = NULL` und `billing_run_id = NULL`. Spaltenanlage läuft
idempotent in `server/startup/ensure-invoice-per-pot-columns.ts` (kein
`drizzle-kit push`, siehe Gotcha in `replit.md`).

## Verlässliches Budget-Migrations-Framework (Task #895)

Einmalige Budget-DATEN-Migrationen mutieren historisierte Finanztabellen
(`budget_allocations`, `budget_transactions`, …) und sind doppelt sensibel:
sie dürfen weder mehrfach laufen noch eine Erhaltungs-Invariante (kein Topf
überzogen, I13) verletzen. Dafür gibt es drei Bausteine.

### Bausteine

- **Ledger (`budget_migrations`)** — `server/startup/ensure-migration-ledger.ts`
  legt die Tabelle idempotent an (eindeutig per `name`). Jede erfolgreiche
  Migration trägt eine Zeile ein → exactly-once, beweisbar. Der Insert läuft
  INNERHALB der Migrations-Transaktion: ein Rollback entfernt ihn wieder, sodass
  die Migration beim nächsten Boot erneut versucht wird.
- **Guarded Runner** — `server/startup/budget-migration-runner.ts`
  (`runGuardedBudgetMigration`) führt eine Migration in EINER Transaktion mit
  transaktions-lokalem GoBD-Bypass (`SET LOCAL app.allow_gobd_mutation='on'`)
  aus, klammert sie mit einem Conservation-Pre-/Post-Check
  (`server/lib/budget-conservation.ts`, SSoT) ein und ROLLT ZURÜCK, sobald die
  Migration eine NEUE Verletzung einführt. Vorbestehende Verletzungen blockieren
  legitime Migrationen NICHT (`assertNoNewConservationViolations`).
- **Registry/Entry-Point** — `runBudgetDataMigrations()` führt alle
  startup-getriebenen Budget-Daten-Migrationen in deterministischer Reihenfolge
  aus, jede fault-isoliert (Fehlschlag → loggen + überspringen, Boot läuft
  weiter). Aktuelle Reihenfolge: `migrate-budget-sources` →
  `backfill-import-update-budget-drift` →
  `backfill-duplicate-wizard-carryovers-601` →
  `backfill-task-684-orphan-auto-carryovers` →
  `backfill-task-685-relink-orphan-carryover-tx` (#685 hängt von der Keep-Wahl
  aus #684 ab und MUSS danach laufen). Der Entry-Point wird in `server/index.ts`
  NACH den GoBD-Immutability-Triggern UND NACH `backfillBudgetHistorization`
  aufgerufen: der Bypass muss gegen aktive Trigger greifen, und die drei
  Carryover-Backfills setzen den partiellen Unique-Index auf `budget_allocations`
  voraus. Der Ledger (`ensureMigrationLedger`) wird weiter oben im Boot
  angelegt, bleibt aber ein separat fault-isolierter Schritt.

### Eine neue Migration anlegen

1. Migrations-Funktion `(tx: Tx) => Promise<BudgetMigrationSummary>` schreiben
   (z.B. in `server/startup/`). Sie MUSS idempotent sein und ausschließlich auf
   `tx` arbeiten (keine eigene Transaktion, kein eigenes Bypass-GUC — beides
   liefert der Runner). Referenz: `server/startup/migrate-budget-sources.ts`.
2. In der Registry in `runBudgetDataMigrations()` mit einem stabilen,
   eindeutigen `name` registrieren.
3. Optionen: `conservationCheck: false` nur für Migrationen, die nachweislich
   keine Topf-Konsumtion berühren; `gobdBypass: false`, wenn keine
   GoBD-geschützte Tabelle angefasst wird.

Das Gating erfolgt über den **Namen**. Ändert sich die Logik einer bereits
angewendeten Migration grundlegend, MUSS ein neuer Name vergeben werden — der
Runner re-runt eine eingetragene Migration nie automatisch.

### Intentionale Abweichung — was NICHT auf dem Framework liegt (Task #896)

Nicht jeder budget-bezogene Startup-Schritt ist eine guarded Daten-Migration.
Die folgenden Schritte mutieren KEINE Topf-Konsumtion und bleiben bewusst
außerhalb der Registry — sie hier zu führen wäre semantisch falsch (kein
exactly-once-/Conservation-Bedarf) bzw. würde wiederkehrende Schritte
fälschlich einmalig gaten:

- **Reine DDL / Trigger / Index** — `ensure-migration-ledger`,
  `ensure-invoice-per-pot-columns`, `ensure-gobd-table-immutability` (+ weitere
  `ensure-*`), `backfill-budget-historization`,
  `drop-customer-budgets-table`, `migrate-km-geo-to-numeric`. Diese legen
  Strukturen/Constraints an oder typisieren Spalten um; keine Pot-Konsumtion,
  daher kein Conservation-Check sinnvoll. (`backfill-budget-historization`
  schreibt zwar `customer_budget_type_settings`-Phasen, berührt aber weder
  `budget_allocations`-Beträge noch `budget_transactions` und ist Vorbedingung
  des Runners — siehe Reihenfolge oben.)
- **Read-only Audits** — `audit-budget-type-settings-chain`,
  `audit-appointment-budget-km-drift`. Loggen nur, mutieren nichts.
- **Wiederkehrende Synchronisation (KEIN one-shot)** —
  `sync-budget-allocations` (`syncAllBudgetAllocations`) läuft bei JEDEM Boot
  und materialisiert abgeleitete Allokationen idempotent neu. Ledger-Gating
  würde es nach dem ersten Lauf fälschlich überspringen → bleibt außerhalb des
  Frameworks.
- **Reines Relinking ohne Beträge** — `backfill-orphan-reversal-appointment-id`
  setzt nur `budget_transactions.appointment_id` auf Reversal-Zeilen nach (GoBD
  CHECK), ohne Beträge/Konsumtion zu ändern; keine Erhaltungs-Invariante
  betroffen.
- **No-Op-Bereinigung** — `clear-45b-monthly-limits` ist nach dem materialisierten
  §45b-Modell effektiv ein No-Op.

Migriert wurden hingegen alle Schritte, die Pot-Konsumtion ändern (Storno +
Neu-Buchung bzw. Soft-Delete/Relink von Carryover-Allokationen):
`backfill-import-update-budget-drift`, `backfill-duplicate-wizard-carryovers-601`
(#601), `backfill-task-684-orphan-auto-carryovers` (#684) und
`backfill-task-685-relink-orphan-carryover-tx` (#685). Referenz für eine
guarded Migration bleibt `migrate-budget-sources`.

### Production-Runbook (sicheres Rollout)

1. **Vorab (lesend, prod-safe):** `tsx server/scripts/verify-budget-conservation.ts`
   gegen die Ziel-DB ausführen. Exit 0 = saubere Baseline. Vorbestehende
   Verletzungen notieren — der Runner toleriert sie, der Operator sollte sie
   aber kennen.
2. **Deploy/Boot:** Beim Start laufen Ledger-Setup + `runBudgetDataMigrations()`
   automatisch. Im Boot-Log nach `[budget-migration]`-Zeilen suchen
   (`applied` / `skipped` / `fehlgeschlagen (Transaktion zurückgerollt)`).
3. **Bei Rollback:** Ein `fehlgeschlagen`-Log bedeutet, die Transaktion (inkl.
   Ledger-Eintrag) wurde zurückgerollt — der Datenbestand ist UNVERÄNDERT. Die
   Ursache (Conservation-Verletzung oder Exception) im Log prüfen, Migration
   korrigieren, neu deployen. Die Migration läuft beim nächsten Boot erneut.
4. **Verifikation (lesend):** Nach dem Boot erneut
   `verify-budget-conservation.ts` ausführen — Exit 0 bestätigt, dass keine neue
   Verletzung eingeführt wurde. Ledger-Stand prüfen:
   `SELECT name, version, summary, applied_at FROM budget_migrations ORDER BY applied_at;`.

### Tests

- `tests/budget-migration-runner.test.ts` — exactly-once (Ledger-Gating),
  Rollback bei Exception (kein Ledger-Eintrag, keine Schreibwirkung), und die
  Conservation-Guard-Entscheidung als Unit-Test.
- `tests/architecture/startup-steps-fault-isolated.test.ts` — verlangt, dass
  `ensureMigrationLedger()` und `runBudgetDataMigrations()` einzeln
  fault-isoliert in `runStartupTasks` liegen.
