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

**Verifikation Phase 3.2 / Befund C-03 (Stand 15.06.2026): grün.** Geprüft wurde, ob Rebook-Preview und tatsächliche Buchung auf unterschiedliche Settings-Stände driften können. Ergebnis:
- **Alle wertrelevanten Lesepfade lesen stichtagsbezogen** (`{ kind: "forDate", asOfDate }` am Termin-/Transaktionsdatum): Konsum-Buchung (`consumption-engine.ts`), Verfügbarkeit/Overview (`unified-reader.ts`, `summary-queries.ts`), Reservierung (`reservation-storage.ts`), Cap-/Allocation-Reads (`allocation-storage.ts`) und die **Umbuchungs-Ausführung** (`rebookSingleTransaction` liest `forDate` am ursprünglichen `transactionDate`).
- **`forEdit`/`withTransition` (jüngster Intent) ist auf Edit-/Operator-Stellen begrenzt:** der Settings-Edit-Endpoint (`GET …/type-settings`, `withTransition`) und die Rebook-Preview-Operator-Ansicht „welche Töpfe sind JETZT deaktiviert?" (`getRebookPreview`, `forEdit`).
- **Keine Preview↔Buchung-Drift bei der Topf-Deaktivierungs-Umbuchung:** die Ausführung (`rebookDisabledBudgetTransactions`) leitet ihre Arbeit aus DERSELBEN `getRebookPreview`-Funktion ab; die Re-Buchung selbst läuft über die `forDate`-Cascade. Preview und Buchung können konstruktiv nicht auseinanderlaufen.
- **Statisch verriegelt** durch die Fitness-Function `tests/architecture/budget-typesettings-read-path.test.ts`: ein wertrelevanter Lesepfad, der versehentlich auf jüngsten Intent umschwenkt, bricht das Gate (Allowlist nur für die o.g. Edit-/Operator-Dateien). Es wurde keine echte Lücke gefunden; daher kein Wert-/Verhaltens-Fix nötig.
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

## Budget-Ledger-Konsolidierung — Stufe A → C (Task #1272–#1274)

Der frühere `budget_ledger` war zuletzt nur noch ein reiner Spiegel von
`budget_transactions` (Capture-Insert im Hard-Hold-Pfad). Er wurde **gestaffelt
und ohne Big-Bang-Drop** entfernt, wobei der Hard-Block-Pfad durchgehend scharf
blieb:

- **Stufe A (Task #1272):** `budget_reservations` bekam den EINEN Capture-Link
  `captured_transaction_id` (→ `budget_transactions.id`) zusätzlich zum alten
  `captured_ledger_id`; dual-write + Backfill.
- **Stufe B (Task #1273):** Die GoBD-Immutability und die
  Conservation-/Invarianten-Checks (`server/lib/budget-conservation.ts`,
  `server/lib/invariants.ts`) wurden auf `budget_transactions` umgezogen — es ist
  damit die EINE append-only Finanz-Schicht. Die DB-Trigger laufen über
  `server/startup/ensure-budget-transactions-immutability.ts`.
- **Stufe C (Task #1274 → #1443/#1446 → #1486):** Die redundante Spiegel-Tabelle
  `budget_ledger` UND der alte Zweit-Link
  `budget_reservations.captured_ledger_id` wurden FK-sicher (erst die FK-Spalte,
  dann die Tabelle) über die freigabe-gegatete Guarded-Migration
  `drop-budget-ledger-1443` in Prod entfernt (**kein `drizzle-kit push`**). Nach
  dem bestätigten Prod-Drop wurde in **Task #1486** das komplette Drop-Gerüst
  abgebaut (Migrationsdatei, Freigabe-Flag `APPROVED_DROP_BUDGET_LEDGER`,
  Preflight-Deskriptor, Schema-Deklaration `budgetLedger`/`capturedLedgerId`). Der
  Drift-Wächter `tests/startup/startup-schema-drift.test.ts` prüft seither den
  Endzustand: weder die Tabelle `budget_ledger` noch die Spalte
  `captured_ledger_id` dürfen im Drizzle-Modell verbleiben. SoT der Buchungen ist
  allein `budget_transactions` mit `captured_transaction_id` als einzigem
  Capture-Link.

**Append-only-Wächter (retargetet):**
`tests/architecture/budget-transactions-write-path.test.ts` (vormals
`budget-ledger-write-path`) bewacht jetzt `budget_transactions`: ein direkter
`db.update/delete(budgetTransactions)` bzw. rohes
`UPDATE/DELETE budget_transactions` ist nur erlaubt, wenn dieselbe Datei den
audit-pflichtigen Bypass-GUC `app.allow_gobd_mutation` setzt (= bewusster
Korrektur-/Cleanup-Pfad). Fehlt der Bypass, ist es ein stiller Schreibpfad und
damit eine Verletzung. `budget_reservations` (Live-Holds, auf jeder
Verfügbarkeits-Berechnung gelesen) und `budget_migrations` (Once-only-Journal)
bleiben PERMANENT erhalten.

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

**Anker-Auflösung — zur Laufzeit PRO TOPF aus der Pflegegrad-Historie (Task #1204):** Es gibt **keinen persistierten kunden-weiten Anker mehr** — die Spalten `customer_budget_preferences.budget_start_date` + `budget_start_date_origin` und der Origin-Wert `'manual'` sind entfernt. Jeder Topf-Lesepfad leitet seinen Anker bei jedem Recompute frisch aus dem **frühesten Pflegegrad-Beginn** (`earliestCareLevelStart`, Care-Level-Historie) ab. Es gibt damit keine „manuell gewinnt"-Sonderbehandlung mehr; der Anker ist eine reine Funktion der Pflegegrad-Historie.

- **§45a (`umwandlung_45a`) / §39+§42a (`ersatzpflege_39_42a`)** lesen den **ROHEN** frühesten Pflegegrad-Beginn (ungekappt), mit ihren bestehenden Fallbacks (Startwert-/Setting-Anker → `1.1. laufendes Jahr`). Diese Töpfe sind uncapped; ein Pflegegrad weit in der Vergangenheit zählt voll.
- **§45b (`entlastungsbetrag_45b`) Lesepfad + Carryover-Anlage** (`calculateAllocated45b` / `ensureYearlyCarryover45b` in `server/storage/budget/allocation-storage.ts`) boden denselben frühesten Pflegegrad-Beginn mit `floorAutoAnchor45bToCurrentYear` auf den **1.1. des laufenden Jahres** (ein Datum davor wird angehoben, ein zukünftiges bleibt). **Warum:** Ein automatischer Vorjahres-Übertrag (bis 12 × 131 € = 1.572 €) hat beim Onboarding keine fachliche Grundlage; das Boden verhindert ihn einheitlich (vorher tauchte z.B. nach dem Löschen einer Carryover-Zeile sofort wieder ein voller Vorjahres-Übertrag auf — E2E-Regression `§45b-Carryover — Löschen … persistiert nach Reload`).
- **`/initial-budget`-Write** (§45b-Block in `server/routes/budget.ts`) bodet den **Stichmonat-Parameter des Requests** identisch (`floorAutoAnchor45bToCurrentYear`), schreibt aber **keine** kunden-weite Anker-Zeile mehr — nur die `initial_balance`-/Carryover-Allokationen tragen den Stichmonat selbst.

Beide §45b-Lesepfad-Blöcke (`calculateAllocated45b` und `ensureYearlyCarryover45b`) und der `/initial-budget`-Write müssen denselben gebodeten Anker verwenden, sonst driften die angezeigte Summe und die tatsächlich angelegten Carryover-Zeilen auseinander.

**FORWARD-ONLY (keine Datenmigration):** Bestehende `budget_allocations`-Zeilen werden NICHT umgeschrieben; nur künftige Recomputes lesen den runtime-abgeleiteten Anker. Die idempotente Spalten-Migration `server/startup/drop-budget-start-date-columns.ts` entfernt die alten Anker-Spalten beim Startup.

### §45b Carryover-Verfall — kein Chaining, Startwert entkoppelt (Task #1392)

Zwei Wurzeln führten zu falschen §45b-Anzeigen (z.B. „−2.012 €", obwohl tatsächlich ~+300 € verfügbar). Beide sind im **einen** Verfügbarkeits-SSoT-Pfad (`calculateAllocated45b` Lesepfad + `ensureYearlyCarryover45b` Auto-Pfad in `server/storage/budget/allocation-storage.ts`) behoben — keine Parallel-Mathematik, `tests/architecture/budget-single-reader.test.ts` bleibt grün.

- **Bug 1 — Carryover-Chaining (Weiterroll-Kette):** Ein bereits hereingerollter Übertrag aus Quelljahr Y darf **nicht erneut** in den Folgejahres-Übertrag wandern. Sein Restguthaben verfällt zu **seiner eigenen** Frist 30.06.(Y+1) und wird via `processExpiredCarryover` als sichtbarer `write_off` ausgebucht — nicht in einen Y+2-Übertrag verschoben. `ensureYearlyCarryover45b` rollt darum nur das im Jahr **selbst** entstandene Guthaben weiter: FIFO `consumedAgainstOwnYear = max(0, netConsumed − totalCarryoverIn)`, `unused = max(0, yearAllocatedCents − consumedAgainstOwnYear)`; bei `unused ≤ 0` entsteht kein neuer Übertrag. **Folge:** Ein Quelljahr-Y-Rest taucht niemals in einem Y+2-Übertrag auf.
- **Bug 2 — Kopplung Startwert(IB)↔Übertrag:** Ein abgelaufener/staler Übertrag darf einen **gültigen** `initial_balance` (Startwert) nicht verdrängen. Der IB-Verfalls-Boden (`ibFloorYear`) ist auf den `expiryFloorAnchorYear` (1. Halbjahr ⇒ Vorjahr, ab Juli ⇒ laufendes Jahr) gebunden — **nicht** mehr auf das späteste vorhandene Übertrags-Jahr (`latestCountedCarryoverYear`). Auch der `allocStart`-Shift nutzt nur **gültige** (noch nicht verfallene) Überträge (`latestValidCarryoverYear`). Damit ein Übertrag und der Startwert **desselben Quelljahrs** nicht doppelt zählen, greift eine **gezielte** IB-Supersession: `supersededIbYears = { validCarryover.year − 1 }` (der Übertrag für Zieljahr T deckt das Quelljahr T−1 ab) — der zugehörige IB wird genau einmal abgezogen, alle übrigen IBs bleiben. `excludedSpecialAllocationIds`-Symmetrie (Allocated ↔ Consumed) bleibt erhalten.

**Akzeptanzkriterien (durch `tests/budget/45b-carryover-verfall-root.test.ts` abgesichert):** (a) ein abgelaufener Übertrag verdrängt keinen in-Fenster-Startwert; (b) Übertrag + Startwert desselben Quelljahrs zählen genau einmal (kein Doppel-, kein Unter-Zählen); (c) Chaining-Regression — ein Y-Quelljahr-Rest erscheint nie in einem Y+2-Übertrag.

**Out-of-scope (#1392):** Bereits fälschlich weitergerollte/abgelaufene Carryover-Zeilen aus der Vergangenheit werden NICHT automatisch migriert; ihr Storno ist eine GoBD-pflichtige Operator-Aufgabe. Der read-only-Report `server/scripts/verify-45b-carryover-verfall.ts` (nur `db.select` + SSoT-Read) listet Auffällige: (A) negative roh-Verfügbarkeit, (B) abgelaufener aktiver Übertrag ohne `write_off`, (C) Chaining-Verdacht (aktive Überträge für aufeinanderfolgende Jahre).

**Entfernte Legacy-Helfer:** `clampDerived45bAnchor` / `earliest45bRelevantAnchor` (`shared/domain/budgets.ts`) und `resolveBudgetAnchor` (`shared/domain/budget/budget-anchor.ts`) wurden ersatzlos entfernt — sie waren seit dem zur Laufzeit pro Topf abgeleiteten Anker (Task #1204) nicht mehr im Runtime-Pfad und überlebten nur in Unit-Tests bzw. im obsoleten Anker-Backfill-Skript (das gegen die gedroppten `budget_start_date`-Spalten schrieb und mitsamt Wrapper/Runbook entfernt wurde). Der §45b-Verfalls-Boden lebt inline in `allocation-storage.ts`; der Auto-Fallback bodet über `floorAutoAnchor45bToCurrentYear`. Drift-Guard gegen ein Wiedereinführen des persistierten Ankers: `tests/architecture/budget-anchor-ssot.test.ts`.

### §45b Startwert (Restguthaben) = Reset/Re-Baseline, nicht additiv (Task #1812, konsolidiert #1766)

Ein gemeldeter §45b-**Startwert (Restguthaben)** zu einem Monat M ist ein **Reset** des Topfes, **kein** additiver Aufschlag. Der Startwert bildet bereits den Stand **nach** allem Verbrauch bis M ab; ihn zusätzlich auf die aus der Pflegegrad-Historie abgeleitete Voll-Ansammlung zu addieren (altes #1766-Verhalten) überzeichnete den Topf (Prod: Startwert 835,68 € ab Juli erschien am Anker 01/2026 als 1.621,68 €).

**Modell A:** `verfügbar(N≥M) = Startwert(M) + Ansammlung(M+1…N) − Verbrauch(≥M) − geplant(≥M)`. Der jüngste Startwert-Monat M (letzte aktive `initial_balance`-Zeile mit Monatsbeginn ≤ `asOfDate`) ersetzt **alle** Ansammlung UND Überträge ≤ M; nur Monate **nach** M stocken weiter auf (auf den Jahres-Cap geklemmt).

**Wo umgesetzt (SSoT, `server/storage/budget/allocation-storage.ts`):**
- **Reset-Monat M** wird in `calculateAllocated45b` **nach** allen `allocStart`-Shifts (Verfalls-Boden/Carryover) bestimmt, um die Kollision mit dem expiryFloor zu vermeiden. Nur im As-of-Modus (`opts.year == null`), **nicht** im `{year}`-Pool-Modus (Carryover-Berechnung).
- `enumStart = max(allocStart-nach-allen-Shifts, M+1)` wird als **lokale** Variable an `enumerate45bStatutoryMonths` übergeben — `allocStart` selbst bleibt unangetastet.
- `ibCounted` verlangt zusätzlich `hasReset && a.year===resetYear && a.month===resetMonth`, sodass **nur** der jüngste Startwert die neue Basis ist; ältere IBs fallen in `excludedSpecialAllocationIds`.
- `Allocated45bResult.resetCutoffDate` (= `${M}-01`, sonst null) steuert `getExcluded45bConsumption`: dieser rechnet in **einer** OR-verknüpften Query (`allocationId IN excludedIds OR transactionDate < resetCutoffDate`) den Vor-Reset-Verbrauch symmetrisch heraus, sodass er **nicht doppelt** abgezogen wird. Symmetrisch über Unified-Reader + Consumption-Engine + `net-available-45b.ts` (alle rufen dieselbe Funktion).

**Anzeige-Kohärenz-Vorbehalt:** Overview `totalAllocatedCents` spiegelt den Reset; das Legacy-`totalUsedCents` summiert weiterhin **allen** Verbrauch (schließt Vor-Reset nicht aus) — nur das servierte `availableCents` ist über den Unified-Reader korrigiert (gleiches Muster wie die #1340-Carryover-Exklusion). `BudgetLedgerSection` weist die Differenz als „aus abgeschlossenem Zeitraum" aus. Tests asserten auf `availableCents`, nicht auf `allocated − used`.

**Nicht angefasst:** Carryover-`allocStart`-Shift (#696/#959), expiryFloor (#959), IB-Supersession (#1392), backdatierte Reads (vor M sehen keinen Reset), §45a/§39, `{year}`-Pool-Modus (Reset dort ausgeschaltet).

### §45b hat KEINEN Fenster-Cap — Monatslimit = akkumulierende Aufstockungsrate

**Entscheidung (Alrik-Direktive):** Für §45b darf es **kein reines Monatslimit** (per-Kalendermonat-Buchungs-Cap) geben. Das §45b-Budget akkumuliert bis zum Stichtag; das per-Kunde konfigurierte §45b-Monatslimit („Unser Anteil") wirkt **ausschließlich** als die monatliche **Aufstockungsrate**, die in die Allocation einfließt (`server/storage/budget/allocation-storage.ts` → `monthlyAmountFor` / `enumerate45bStatutoryMonths`). Es ist **kein** zweiter Buchungs-Cap.

**Warum:** Der frühere §45b-Fenster-Cap (Task #1171/BUG-21) hat genau dieses Limit ein **zweites** Mal angewandt — als per-Kalendermonat-Reset-Cap auf den bereits akkumulierten Topf. Diese Doppel-Anwendung ist die Wurzel des wiederkehrenden §45b-**Hard-Blocks beim Dokumentieren** (ein Termin, dessen Kosten die Monatsrate übersteigen, aber im Jahrestopf Platz haben, wurde fälschlich geblockt bzw. in den Selbstzahler-Topf umgeleitet). Derselbe Symptom-Fall wurde zuvor pro Kunde per Datenfix (`server/scripts/fix-customer-182-budget-cap.ts`, Task #423: `monthly_limit_cents → NULL`) repariert — der Cap regressierte aber strukturell immer wieder.

**Wo umgesetzt (SSoT, kein Parallel-Pfad):**
- `shared/domain/budget/cap-math.ts` — der §45b-Zweig liefert **immer** `Number.POSITIVE_INFINITY` (der Statutory-Clamp berechnet weiterhin `clampedMonthlyLimitCents` informativ/für die Aufstockungsrate, erzeugt aber keinen Cap).
- `server/storage/budget/consumption-engine.ts` — §45b ist **nicht** mehr in `isCappedBudget` (nur §45a/§39 behalten ihren legitimen statutorischen Fenster-Cap).
- `server/storage/budget/unified-reader.ts` — der §45b-Block setzt `capRemainingCents = Infinity`, `availableCents` folgt allein der bis zum Stichtag aufgelaufenen Allokation (`net-available-45b.ts`, der bereits cap-freie Pre-Cap-SSoT, bleibt unverändert).

**Akzeptanz-Tests:** `tests/budget/cap-math.test.ts` (§45b immer ∞), `tests/equality/45b-cap.test.ts` (gesetztes Limit → §45b bucht voll aus dem akkumulierten Topf, kein Selbstzahler-Überlauf, kein Hard-Block), `tests/budget/45b-forecast-incident-regression.test.ts` (Served-Pfad ungekappt, Forecast byte-identisch zur Legacy).

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

## Storno-Integrität — kein „Storno eines Stornos" (Task #1170)

Eine Reversal-Zeile darf nur eine `consumption`/`write_off` zurücknehmen,
**niemals eine andere `reversal`**. Würde R2 die Reversal R1 stornieren, hebt R2
(mit umgekehrtem Vorzeichen von R1) die legitime Storno-Gutschrift wieder auf —
ohne dass ein realer Termin neu dokumentiert wurde. Folge: Wieder-Verbrauch ohne
Beleg; die drei Lesepfade (Σ Transaktionen / FIFO-Breakdown / Overview) driften
auseinander.

**Schreib-Guard** (`reverseBudgetTransactionWithOutcome` in
`server/storage/budget/transaction-storage.ts`, durchgereicht vom Route-Handler
`POST /api/budget/transactions/:id/reverse`):
- Original ist `reversal` → `400 REVERSAL_NOT_REVERSIBLE` (deutsche Meldung).
- Original ist bereits storniert (verknüpft ODER Note-Waise) → `409 ALREADY_REVERSED`,
  **keine** zweite Reversal-Zeile, **kein** zweiter Audit-Eintrag (idempotent).
- Original existiert nicht → `404 NOT_FOUND`.
- sonst → `201` mit neuer Reversal-Zeile + Audit `budget_reversal`.

Die Bestands-Signatur `reverseBudgetTransaction` (Bulk-Aufrufer: Termin-/
Rechnungs-Storno, Import-Reconcile, Rebook) bleibt `BudgetTransaction |
undefined` und ist ein dünner Wrapper; sie stornieren ausschließlich
`consumption`-Zeilen und treffen den Guard daher nie — er bleibt Sicherheitsnetz.

**Invarianten-Test** (Drift-Detektor, erweitert die bestehende FIFO-/Equality-
Suite, KEINE parallele Suite):
`tests/equality/45b-fifo-breakdown-consistency.test.ts` — nach Storno gilt
`−Σ(amountCents über consumption/write_off/reversal, transactionDate≤asOf)` ≙
`FIFO.totalConsumedCents` ≙ `Overview.totalUsedCents` (ohne `manual_adjustment`,
Phase-6-Schatten-Drift bewusst ausgeklammert). Reine Detektor-Logik (SSoT):
`shared/domain/budget/phantom-storno.ts` (`detectReversalChains`), getestet in
`tests/architecture/phantom-storno-detector.test.ts`.

**Bestandsdaten-Reparatur** (GoBD append-only, Trockenlauf-Default):
`server/scripts/reconcile-reversal-chains.ts` findet Reversal-Ketten (R2 → R1,
R1 selbst `reversal`) und schreibt pro Kette eine inverse Ausgleichs-
`consumption` (alle Spalten vorzeichen-invertiert, Σ R2 + Korrektur = 0). Wie
das Phantom-Storno-Skript: `--apply` erfordert `--user=<superadmin>` +
`--reason` (≥10 Zeichen), idempotent über die eindeutige Korrektur-Notiz,
Audit pro Korrektur + Sammel-Eintrag. R2 bleibt unangetastet stehen
(Revisionssicherheit). Proof-Daten: Kunde 203050, Tx 510351/510352.

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

**Abgrenzung — Vorgängerphase vorhanden (Task #1169, GoBD-Härtung):** Der
Pull-Forward greift nur, wenn die zukunftsdatierte Zeile die **einzige** den
Stichtag betreffende Konfiguration ist (klassischer BUG-13: keine andere Zeile
überdeckt `today`). Steht **hinter** der offenen Zukunftszeile bereits eine
in Kraft befindliche Vorgängerphase (eine andere Zeile mit
`validFrom <= today` und `validTo IS NULL OR validTo >= today`), wäre ein
Pull-Forward revisions-schädlich: er würde die geplante Zukunftsphase
überschreiben und die Zukunftszeile mit der noch gültigen Vorgängerzeile am
selben Stichtag überlappen lassen (zwei aktive Versionen). Daher wird ein PUT
**ohne** `validFrom` in dieser Konstellation als **neuer Versionssatz „ab
heute"** behandelt: der Vorgänger wird auf `validTo = today - 1` geschlossen,
eine neue Zeile `[today .. Zukunft - 1]` eingeklemmt, und die Zukunftsphase
bleibt unangetastet. So bleibt für jeden Tag X genau eine aktive Zeile
rekonstruierbar. Dies läuft über denselben Phasen-Append-Pfad (kein zweiter
Versionierungs-Codepfad), nur mit Stichtag `today` statt einem expliziten
Zukunftsdatum.

Regressions-Tests: `tests/budget/type-settings-future-row-overwrite.test.ts`
(BUG-13 Pull-Forward) und `tests/budget/task-1169-settings-revisionssicher.test.ts`
(Versionssatz-ab-heute-Abgrenzung + 3-Schritt-Audit-Sequenz).

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

## E-Rechnung (ZUGFeRD/Factur-X EN 16931) — Abgrenzung & Validierung (Task #1073)

**Was die eingebettete ZUGFeRD/Factur-X-XML IST:** die maschinenlesbare
Repräsentation der **umsatzsteuerlichen, menschenlesbaren Rechnung** nach
EN 16931 (deutsches Profil; Standard-Profil seit Task #1073 = `en16931`,
vorher `basic`). Sie ist Teil des hybriden PDF/A-3-Dokuments (sichtbares PDF
+ eingebettete `factur-x.xml`) und dient der **GoBD-konformen Rechnungs-
stellung** an Pflegekasse, Beihilfe oder Selbstzahler. Empfänger, Beträge,
Steuerkategorien und §-Hinweis (BT-22-Note) spiegeln exakt die Buchung. Pro
Position wird zudem der **Pro-Zeilen-Betrag (BT-131, `LineTotalAmount`)**
ausgegeben (Task #1098), der bit-genau dem persistierten `totalCents` der
(ggf. kumulierten) Position entspricht — Σ(BT-131) == Nettobetrag. Hinweis:
node-zugferd erwartet im Line-Block den Schlüssel `lineTotalAmount`; der
frühere `totalAmount` wurde still verworfen, sodass das XML vor #1098 keinen
BT-131 trug und nur über den Non-Strict-Fallback konform war. BT-131 wird
analog zu Profil/Aggregationsmodus per `InvoiceRenderSnapshot`
(`includeLineTotalAmount`) eingefroren: vor #1098 versiegelte Bestände tragen
das Flag nicht und re-rendern bewusst **ohne** BT-131 (byte-stabiler
Re-Render, GoBD-Hash-Stabilität); neue Rechnungen werden mit `true` versiegelt.

**Was sie ausdrücklich NICHT IST:** der **sozialrechtliche Leistungs-/
Abrechnungs-Datenaustausch** mit den Kostenträgern nach **§ 105 SGB XI**
(Pflege) bzw. **§ 302 SGB V** (häusliche Krankenpflege / Hilfsmittel). Jener
Datenaustausch läuft über ein **separates, technisch unabhängiges Verfahren**
(EDIFACT/PFLEGE bzw. die TA-/Datenträger-Spezifikationen der GKV, i.d.R. über
ein Abrechnungszentrum). Die ZUGFeRD-Rechnung ersetzt diesen Kanal nicht und
wird nicht aus seinen Datenstrukturen erzeugt. Wer „E-Rechnung" sagt, meint
hier **immer** die EN-16931-USt-Rechnung, nie den §105/§302-Kanal.

**Silent-Fallback ist jetzt protokolliert:** Kann node-zugferd die XML nicht
im Strict-Modus (XSD-validiert) erzeugen, fällt der Renderer auf Non-Strict
zurück, **bricht aber die GoBD-Byte-Determinismus-Garantie nicht** (gleiches
Snapshot ⇒ gleiches XML ⇒ gleicher Integritätshash). Statt still zu degradieren
wird beim Versiegeln ein Audit-Log-Eintrag `invoice_zugferd_nonstrict_seal`
geschrieben. Bereits versiegelte Bestand-Rechnungen ohne `profile` im Snapshot
werden bewusst weiter als `basic` re-gerendert, damit ihre versiegelte XML
byte-identisch bleibt.

**Validierungs-Gate:** `npm run validate:erechnung` erzeugt eine Beispiel-
EN-16931-PDF/A-3 (ohne Chromium) und prüft sie mit den offiziellen Werkzeugen
Mustang/KoSIT (EN-16931-Schematron) und veraPDF (PDF/A-3b). Ohne Java
überspringt sich das Skript sauber; der CI-Job `erechnung-validation` erzwingt
die Prüfung. Runbook: [`docs/erechnung-validation.md`](../erechnung-validation.md).

### Bestandsrechnungen-Backfill auf EN 16931 — Entscheidung (Task #1081)

**Frage:** Müssen die VOR der Profil-Umstellung (Task #1073) versiegelten
Bestandsrechnungen — eingebettete ZUGFeRD-XML im Profil `basic` — nachträglich
auf das `en16931`-Profil gehoben („re-sealed") werden?

**Entscheidung: NEIN. Kein erzwungener Backfill.** Bestandsrechnungen behalten
ihre versiegelte BASIC-XML; ein In-Place-Re-Seal wird bewusst **nicht**
implementiert.

**Begründung:**

1. **Keine Konformitätslücke.** Das ZUGFeRD/Factur-X-Profil **BASIC ist bereits
   ein konformer Subset von EN 16931** (im Gegensatz zu `MINIMUM`/`BASIC WL`,
   die reine Buchungshilfen und NICHT EN-16931-konform sind). Eine mit BASIC
   versiegelte Bestandsrechnung ist also eine rechtlich gültige
   EN-16931-Rechnung. `en16931` (COMFORT) erlaubt nur zusätzliche **optionale**
   Felder — es ist nicht „konformer", sondern nur reichhaltiger. Es gibt damit
   nichts zu „reparieren".
2. **GoBD-Immutabilität.** `pdf_hash`, `zugferd_xml` und `render_snapshot` sind
   versiegelt und per BEFORE-Trigger schreibgeschützt. Ein Re-Seal würde genau
   diese unveränderlichen Felder mutieren (neue XML ⇒ neuer `pdf_hash`) — ein
   GoBD-Verstoß. Zusätzlich reproduziert ein Re-Render der Pre-#1047-Bestände
   ihren versiegelten Hash ohnehin **nie** byte-genau (verlorene
   Wall-Clock-/XMP-Zeitstempel), weshalb die bestehenden Korrektur-Skripte
   solche Objekte korrekt **flaggen** statt zu überschreiben.
3. **Bewusste Bestands-Politik.** Die Render-Pipeline rendert versiegelte
   Bestände ohne `profile` im Snapshot absichtlich weiter als `basic` (Byte-
   Stabilität, siehe oben). Ein Backfill würde diese Garantie unterlaufen.

**Falls ein Upgrade je DOCH zwingend würde** (nur denkbar, wenn eine künftige
gesetzliche Pflicht ein EN-16931-Pflichtfeld verlangt, das BASIC strukturell
nicht trägt): Der GoBD-konforme Weg ist dann **Storno + Neuausstellung** (alte
Rechnung stornieren, neue Rechnung mit neuer Nummer und frisch versiegeltem
`en16931`-Dokument), **nicht** ein stilles Re-Seal der versiegelten Felder.

Ein erzwungenes In-Place-Re-Seal käme nur als allerletztes Mittel in Frage und
müsste exakt das Muster der bestehenden Korrektur-Skripte
(`regenerate-clobbered-invoice-pdfs.ts` /
`restore-legacy-invoice-pdfs-from-backup.ts`) spiegeln: Trockenlauf als Default,
`--apply` nur mit `--user=<superadmin>` + `--reason` (≥10 Zeichen), eine eigene
Append-only-Audit-Action (z.B. `invoice_zugferd_profile_upgraded`), atomares
Schreiben von PDF-Bytes + `zugferd_xml` + `pdf_hash` + `render_snapshot.profile`
und ein GoBD-Trigger-Bypass (`SET LOCAL app.allow_gobd_mutation='on'`). Mangels
Bedarf ist dieser Pfad **absichtlich nicht gebaut**.

## Re-Buchung netto-null-belegter Termine bei Re-Abrechnung (Task #1014)

**Entscheidung: JA — bei der Rechnungs-ERSTELLUNG (niemals in der Preview)
wird für netto-null-belegte Termine frische Cascade-Konsumption gebucht.**

### Problem

Wird eine Rechnung storniert, läuft pro Termin ein Budget-Reversal: der
Termin wird wieder abrechenbar und seine Konsumption ist **netto null**
(alle `consumption`-Zeilen sind durch `reversal`-Zeilen storniert). Beim
Re-Abrechnen deriviert `getBudgetSplitForAppointments`
(`rederiveSplitFromCurrentAllocation`, Task #1011) den Pot-Anteil
**read-only** aus der aktuellen Allocation — es wird NICHTS gebucht. Folge:
Die neue Rechnung weist einen Topf aus (z.B. §45b), während der Ledger den
Topf weiterhin als „verfügbar" führt. Ein **späterer** Termin verbraucht
denselben Topf erneut → derselbe Topf ist über **zwei aktive Rechnungen**
doppelt belegt (Doppel-Spend, GoBD-/Finanz-Drift).

### Lösung (Trigger: Generate, nicht Preview)

In `generateInvoiceCore` (`server/services/invoice-calc.ts`) werden VOR dem
Bauen des finalen Drafts die netto-null-Termine ermittelt
(`findNetZeroBilledAppointments`, SSoT-Detektion via
`loadAppointmentConsumptionTxns` + `computeNetZeroApptIds` in
`invoice-data.ts`). Für diese Termine bucht
`rebookNetZeroAppointmentConsumption`
(`server/storage/budget/rebook-storage.ts`) frische GoBD-append-only
`consumption`-Zeilen über `createCascadeConsumption` — gegen die heute
verfügbaren Töpfe in derselben Standard-Priorität §45b → §45a → §39/§42a,
Rest → privater uncapped-Topf. Danach wird der Draft NEU gebaut, sodass der
Split aus den frisch gebuchten Live-Zeilen kommt. **Eine Quelle: die
gebuchten Zeilen — Rechnung == Ledger per Konstruktion.**

Die **Preview** bleibt strikt read-only (sie liest weiter über
`rederiveSplitFromCurrentAllocation`) — eine Vorschau darf den Ledger nie
verändern.

### Kein Doppel-Spend, idempotent

- Gebucht wird **ausschließlich** für Termine OHNE Live-Konsum
  (`hasLiveConsumption === false`). Nach erfolgreicher Buchung ist der Termin
  nicht mehr netto-null → ein erneuter Generate-Lauf erkennt ihn nicht mehr
  als netto-null und bucht NICHT erneut.
- Die Netto-Null-Prüfung läuft pro Termin UNTER dem Pro-Kunde-
  Advisory-Lock (`pg_advisory_xact_lock('budget_consumption_' || customerId)`),
  identisch zur normalen Konsum-Buchung — parallele Läufe können nicht doppelt
  buchen.
- Der private Terminal-Topf (`privatePot: { statutoryExcluded: false,
  noteKind: "privatzahlung" }`) absorbiert jeden Rest → kein
  `outstandingCents`, kein Hard-Block.

### Akzeptierter Preview-vs-Generate-Drift

Die Preview-Re-Derivation nutzt `readUnifiedBudgetAvailability` → `planCascade`,
die Generate-Buchung nutzt `createCascadeConsumption` (FIFO-Availability +
Cap-Slot). In seltenen Fällen kann der Pot-Split der Preview minimal von dem
der erstellten Rechnung abweichen. Das ist akzeptiert: Die **erstellte
Rechnung mit ihren Live-Ledger-Zeilen ist die Quelle der Wahrheit**, die
Preview ist nur eine unverbindliche Vorschau.

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
