# Budget-SSoT Phase 0 — Inventur aller Berechnungs- und Anzeigestellen

> **Vereinbarter Endzustand:** Dieses Inventar ist die Ist-Analyse und der Migrationspfad.
> Die **verbindliche Ziel-Architektur** (Drei-Tabellen-Modell, Reservierung/Finanz-Split,
> GoBD-Posture) lebt in
> [`./architecture/budget-greenfield-architecture.md`](./architecture/budget-greenfield-architecture.md)
> mit den Phase-0-Entscheidungen in
> [`./architecture/adr/`](./architecture/adr/). Diese Inventur wird von dem North-Star-Dokument
> als „halb-fertige SSoT-Migration" abgelöst und dient ihm als Karte des Ist-Zustands.
>
> **Status:** Analytisches Inventar (Task #712). KEINE Code-Änderungen.
> **Ziel:** Vollständige Karte aller Stellen in Server, Client und Shared-Code,
> an denen Budget-Werte berechnet, aggregiert oder angezeigt werden — als
> Planungsgrundlage für die nachfolgende Konsolidierung auf eine echte
> Single-Source-of-Truth (eine Read-Schicht pro „View": Overview, Settings,
> History).
> **Out of scope:** Refactoring, neue Views, Architecture-Tests, andere
> Domänen (Pricing, Zeiten, Rechnungen).

## Lesehilfe

- **Spalten je Eintrag:** Datei + Zeilen / Was wird berechnet / Wofür / Inputs
  (Tabellen + Settings + asOfDate-Verhalten) / Drift-Hinweis.
- **Pot-Kürzel:** §45b = `entlastungsbetrag_45b`, §45a = `umwandlung_45a`,
  §39/§42a = `ersatzpflege_39_42a`.
- **Buckets (Ziel-Views):** **Overview**, **Settings**, **History/Audit**.
- **GoBD-Trigger:** Alles, was ein `asOfDate`/`transactionDate` braucht,
  ist historisierungs-sensitiv (Lookups gegen historisierte
  `customer_budget_type_settings`).

---

## 1. SERVER-Inventar

### 1.1 Pot-übergreifend: Allocation- & Cap-Mathematik

#### `server/storage/budget/allocation-storage.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `calculateAllocatedCents` (L347–391) | Einheitlicher Einstieg pro Pot; ruft den jeweiligen `calculateAllocated45b/45a/39_42a` auf und addiert `source='manual_adjustment'`-Allocationen | Booking + Overview + Preview | `budget_allocations`, `customer_budget_type_settings`, `customer_budget_preferences`, `asOfDate \| year` | Manual-Adjust-Sum nach Year ODER nach Date — verschiedene Aufrufpfade liefern je nach `opts`-Form unterschiedliche Zahlen für „selben" Pot |
| `calculateAllocated45b` (L455–~660) | Virtuelle §45b-Auto-Renewal-Summe (kein DB-Row pro Monat) + Initial-Balances + Carryover bis `asOfDate` | Overview, Booking-Cap, Preview | `budget_allocations`, `customer_budget_type_settings` (historisiert, monthly-Anteil), `customer_budget_preferences.budgetStartDate`, `asOfDate` | Komplexester Pfad. Doppelzählungs-Schutz für (a) Auto-Renewal vs. Initial-Balance pro Monat, (b) Auto-Carryover vs. manueller Carryover pro Quelljahr. Hotspot. |
| `calculateAllocated45a` (im selben File) | §45a Monatswert; lehnt sich an `monthlyLimitCents` an | Booking-Cap, Overview | `customer_budget_type_settings` (`monthlyLimitCents`), `asOfDate` | Eigener Pfad ohne Auto-Renewal — Drift-Risiko nur über Settings-Historie |
| `calculateAllocated39_42a` | §39/§42a Jahreswert | Booking-Cap, Overview | `customer_budget_type_settings` (`yearlyLimitCents`), `year` | Year-basiert, NICHT date-basiert — Asymmetrie zu §45a/§45b |
| `getMonthlyBudgetAmountCents` (L283–321) | §45b „Unser Anteil" / Monatsaufstockungsbetrag für ein Datum | Input für `calculateAllocated45b` | `customer_budget_type_settings` (historisiert), Fallback `customer_budgets` (Legacy!), `BUDGET_45B_MAX_MONTHLY_CENTS` (131 €) | Dualer Fallback auf Legacy-`customer_budgets` ist die einzige Stelle, die diese Tabelle noch liest. Wenn `customer_budgets` migrationsfrei abgeschaltet wird, MUSS dieser Pfad genullt werden. |
| `getCustomerBudgetAmounts` (L323–345) | Legacy-Getter „pflegesachleistungen36 / verhinderungspflege39" | (nur noch) Lesefassade über `customer_budgets` | `customer_budget_type_settings` mit Fallback auf `customer_budgets` | Duplikat zur Settings-Konfiguration; potenziell tote Anzeige-Quelle — Migrationskandidat. |
| `ensureYearlyCarryover45b` (L948+) | Idempotenter Auto-Carryover-Insert beim Jahreswechsel | Synchronisation vor Overview & Booking | `budget_allocations` (Quelljahr-Dedup über `existingCarryoverYears`), `budget_transactions` (Vorjahresrest) | Teilt sich den Quelljahr-Schlüssel mit `upsertCarryoverAllocation` (manuell) — Kollisionsschutz, aber unterschiedlicher Trigger-Pfad |
| `syncCarryoverAndExpiry` | Hub-Funktion: ruft Auto-Carryover & Expiry-Cleanup | Wird VOR `getBudgetSummary`, `getAvailableForDate` und `createCascadeConsumption` aufgerufen | Direkte Tabellen-Schreibzugriffe | Drei Aufrufer; bei einem vergessenen Aufruf wandern Allocation-Zahlen leise auseinander |
| `upsertInitialBalanceAllocation` (L47–137) | §45b-/§45a-/§39 Startwert anlegen/ersetzen | Settings + Audit | `budget_allocations` | GoBD: KEIN Resurrect — Ersatz-Insert + `budget_allocation_resurrected`-Audit |
| `upsertCarryoverAllocation` (L154–245) | Manueller §45b-Carryover (Restguthaben aus Vorjahr) | Settings + Audit | `budget_allocations` (per `sourceYear`-Dedup) | Same-Key-Logik wie Auto-Carryover-Pfad; semantisch identisches Ergebnis, aber zwei Schreibpfade |
| `getInitialBalanceAllocations` (L247–269) | §45b: liefert `initial_balance` UND `carryover`; sonst nur `initial_balance` | History-Liste in Settings-UI | `budget_allocations` | §45b-Sonderfall: einzige Stelle, die `initial_balance` und `carryover` zu einer Liste fusioniert (siehe Task #608) |
| `createBudgetAllocation` / `getBudgetAllocations` | Roher CRUD-Zugriff | Einzelnachweise, Allocation-Liste | `budget_allocations` | Nur konsumierende Helfer — keine Berechnung, aber Read-Direkt-Zugriff |

#### `server/storage/budget/cap-calculator.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `computeCapSlot` (L106–171) | Restkapazität eines Cap-Fensters (Monat §45a / Jahr §39+42a; §45b = ∞ — das §45b-Monatslimit ist nur die akkumulierende Aufstockungsrate, KEIN Buchungs-Cap, siehe budget.md „§45b hat KEINEN Fenster-Cap") inkl. statutorischer Klemme | **Booking** (`createCascadeConsumption`) UND **Preview** (`getAvailableForDate`) — explizit als SSoT geteilt | `budget_transactions` (`consumption` − `reversal` im Fenster), `customer_budget_type_settings`, `customers.pflegegrad` (für §45a-Clamp), `getTotalCarryoverCents` für §45b | **Bewusst dedupliziert**: Booking und Preview MÜSSEN diesen Helper aufrufen, sonst driften sie. Soll-Zustand. |
| `netConsumedInRange` (L46–74) | Netto-Verbrauch (`consumption − reversal`, OHNE `write_off`) in einem Datumsfenster | Helper für `computeCapSlot` | `budget_transactions` | Bewusste Asymmetrie zu `import-availability.netConsumedUpToDate` (das `write_off` mitzählt) — siehe 1.4 |

#### `server/storage/budget/summary-queries.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `getTotalCarryoverCents` (L23–41) | Summe **aktiver** Carryover-Allocations zum Stichtag | `computeCapSlot` (§45b-Window), Overview | `budget_allocations` | Konsumiert die rohen Cents — KEINE Berücksichtigung des bereits verbrauchten Carryover-Anteils (das macht `getAvailableCarryoverCents`) |
| `getAvailableCarryoverCents` (L43–94) | Carryover-Rest pro Allocation nach Abzug zugeordneter `consumption`/`write_off` | Detail-Anzeige Carryover-Tabelle | `budget_allocations`, `budget_transactions` | Zweite Carryover-Lesart neben `getTotalCarryoverCents` — selber Pot, andere Zahl. Hotspot. |
| `getBudgetSummary` (L96–285) | §45b-Header: total/used/available/planned/currentMonth/carryover/currentYearAllocated/isCurrentlyActive | Overview (Hauptkomponente) | `calculateAllocatedCents`, `budget_transactions` (`consumption + write_off − reversal` insgesamt + aktueller Monat), Planned via `getPlannedCostCents`, `customer_budget_type_settings` | Liefert ein Drittel der Felder, die UI rendert — Rest kommt aus `getAllBudgetSummaries`. Single-File-DTO-Provider. |
| `getBudgetSummary45a` (L287–337) | §45a Monatswerte | Overview | `budget_transactions`, `customer_budget_type_settings`, Legacy-Fallback `customer_budgets` | Eigene Implementierung der Cap-Mathematik — kein Aufruf von `computeCapSlot` → potenzieller Drift |
| `getBudgetSummary39_42a` (L339–383) | §39/§42a Jahreswerte | Overview | `budget_transactions`, `customer_budget_type_settings`, Legacy-Fallback `customer_budgets` | Eigene Cap-Mathematik (Year) — kein `computeCapSlot` → Drift möglich |
| `getAllBudgetSummaries` | Bündelt die drei `getBudgetSummary*` zu einem DTO | Route `/overview` | siehe oben | Reine Komposition; aber: die Route `/summary` ruft nur `getBudgetSummary` (§45b) — zwei verschiedene Header-Quellen für „die" Budget-Übersicht |
| `getPlannedCostCents` (Pfad: `appointment-cost-calculator.ts`) | Geplante zukünftige Kosten | Overview „availableAfterPlanned" für §45b | `appointments` + Pricing | NICHT in Cap-Mathematik integriert — Anzeige-only |

#### `server/storage/budget/consumption-engine.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `consumeFifo` (L109–271) | FIFO-Abbuchung eines Betrags aus einem Pot, schreibt `budget_transactions` | Booking + Rebook | `budget_allocations`, `budget_transactions`, `calculateAllocatedCents` (historisiert), Settings | Trifft die echten Allocation-Zahlen — wenn sie woanders falsch berechnet werden, bucht es falsch. Quantisiert km via `quantizeKm` (Shared). |
| `createCascadeConsumption` (L273–442) | Cascade über alle aktiven Töpfe nach `DEFAULT_BUDGET_POT_ORDER`, ruft `computeCapSlot` & `consumeFifo` | Booking | Settings (historisiert!), `computeCapSlot`, `customer_budget_preferences` (Legacy-Fallback für §45b-Monatslimit) | **Einer der wenigen Pfade, der den Settings-Historisierungs-Snapshot zur `transactionDate` nutzt** — sehr leicht zu brechen, wenn Aufrufer das `transactionDate` vergisst |
| `createConsumptionTransaction` (L444+) | Einstieg vom Termin-Flow; berechnet Kosten, holt `selbstzahler`-Fast-Path | Booking | `calculateAppointmentCost`, `customers.acceptsPrivatePayment`/`billingType` | Selbstzahler-Branch UMGEHT Cascade vollständig (Task #588) — eigene „kostenmathematische Insel" |

#### `server/storage/budget/import-availability.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `getAvailableForDate` (L57–164) | Pro-Pot verfügbarer Betrag zu einem `transactionDate` (was-würde-buchbar-sein) | Preview im Cost-Estimate + Excel-Import | `calculateAllocatedCents`, `computeCapSlot`, `getActiveBudgetTypeSettings(transactionDate)`, `netConsumedUpToDate` | **SSoT-Anker mit Booking** über `computeCapSlot`. ABER: nutzt `netConsumedUpToDate` (Cumulative bis Datum) für §45b statt Window-Logik — eigene Mathematik, die für §45a/§39 nicht greift |
| `netConsumedUpToDate` (L16–41) | Kumulierter Netto-Verbrauch bis Datum, INKL. `write_off` | §45b-Verfügbarkeit | `budget_transactions` | Asymmetrie zu `cap-calculator.netConsumedInRange` (ohne `write_off`) — bewusst, aber **leicht zu verwechseln** |

#### `server/storage/budget/rebook-storage.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `rebookSingleTransaction` (L17–128) | Eine Transaktion in anderen Topf umbuchen | Admin-Korrektur | `budget_transactions`, `getActiveBudgetTypeSettings(originalTxDate)`, `consumeFifo` | Historisierungs-aware (Task #440) |
| `getRebookPreview` (L130–183) | Übersicht der Transaktionen, die durch deaktivierte Töpfe umgebucht werden müssten | Admin-Anzeige | `budget_transactions`, `getBudgetTypeSettings` (HEUTE) | Liest HEUTIGE Settings, schaut aber auf HISTORISCHE Transaktionen — Mismatch-Risiko |
| `rebookDisabledBudgetTransactions` (L185–351) | Massen-Umbuchung disabled-Töpfe | Admin-Aktion | `budget_transactions`, `appointments`, `appointmentServices`, `calculateAppointmentCost`, `createCascadeConsumption` | Eigene Re-Cost-Berechnung pro Termin |
| `server/storage/budget/km-rebook.ts` | km-Korrektur-Rebook (Trigger-Vokabular siehe `shared/domain/budget-rebook-triggers.ts`) | Trigger-basierter Audit | `budget_transactions` | Eigener Schreibpfad neben Rebook — Auditkonsistenz hängt am Trigger-Enum |

#### `server/storage/budget/transaction-storage.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `createBudgetTransaction` / `reverseBudgetTransaction` | CRUD + Storno | Booking, Audit | `budget_transactions` | Reine Persistenz |
| `getBudgetTransactions` / `getTransactionByAppointmentId` / `getTransactionsByAppointmentId` | Liste/Lookup für UI & Auditpfade | History | `budget_transactions` | Read-only |

#### `server/storage/budget/preferences-storage.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `getBudgetPreferences` / `upsertBudgetPreferences` | Globale Kunden-Präferenzen (Start-Datum, alter Monatslimit-Fallback) | Settings, Allocation-Berechnung | `customer_budget_preferences` | Legacy-Fallback-Quelle für §45b-Monatslimit (siehe `getMonthlyBudgetAmountCents`) |
| `getActiveBudgetTypeSettings(asOfDate)` (L65–85) | Pro Pot die **zum Stichtag** historisierte Zeile | **Alle GoBD-Pfade** (Booking, Preview, Rebook, Allocation) | `customer_budget_type_settings` | **Kritischer Lookup** — wenn ein Aufrufer fälschlich `getBudgetTypeSettings()` (=today) nutzt, driftet Vergangenheits-Booking |
| `getBudgetTypeSettings` (L92–94) | Heute-aktive Zeilen | Anzeige-Default, Cost-Estimate-Route, Rebook-Preview | `customer_budget_type_settings` | „Soft-Default" — semantisch fragil, weil leicht versehentlich für Vergangenheits-Lookups benutzbar |
| `getLatestBudgetTypeSettings` (L127–160) | „Latest Intent" pro Pot (auch zukünftige Zeilen) | UI-Edit-Pfad | `customer_budget_type_settings` | Eigene Auswahl-Heuristik (offen schlägt geschlossen, jüngstes `validFrom` gewinnt) — dritter Lese-Algorithmus für dieselbe Tabelle |
| `getLatestBudgetTypeSettingsWithTransition` (L201–228) | Latest Intent + `effectiveToday`-Snapshot für UI-Übergangshinweis | Settings-UI | `customer_budget_type_settings` | Vierter Lese-Algorithmus, kombiniert die zwei vorhergehenden |
| `upsertBudgetTypeSettings` (L269–435) | Historisierte Settings-Aktualisierung (Append-only via `validTo`/`validFrom`) | Settings-Save | `customer_budget_type_settings`, Audit | Same-day-In-Place-Update vs. Echte-Transition — komplexe Heuristik (Task #608/#652) |
| `clearLegacyInitialBalanceFromSettings` (L450–484) | Nullt Legacy-Felder beim Carryover-Delete | Allocation-Delete-Pfad | `customer_budget_type_settings` | Brückenstelle Legacy ↔ Allocation — Aufruf-Vergessen → Geister-Übertrag |

#### `server/storage/budget/appointment-cost-calculator.ts`

| Stelle | Was | Wofür | Inputs | Drift-Hinweis |
|---|---|---|---|---|
| `calculateAppointmentCost` | Kosten in Cents (HW, AB, Travel-km, Customer-km) für einen Termin | Booking, Cost-Estimate, Rebook | `customer_service_prices`, `services`, `quantizeKm` | Pricing-Domain — aber Output speist Budget-Booking direkt |
| `getPlannedCostCents` | Summe geplanter zukünftiger Termin-Kosten | Overview §45b „Planned" | `appointments`, Pricing | Anzeige-only, aber UI rendert es als wäre es buchbar |

### 1.2 Route-Ebene

#### `server/routes/budget.ts`

| Route | Storage-Call | Bucket | Drift |
|---|---|---|---|
| `GET /:customerId/summary` | `getBudgetSummary` (nur §45b!) | Overview (Legacy) | Doppelung zu `/overview`; nur ein Pot — irreführend |
| `GET /:customerId/overview` | `getAllBudgetSummaries` → re-mapped DTO (L243–280) | Overview | **Hauptlieferant** der Customer-Detail-Page. Eigenes Re-Mapping schneidet Felder aus dem DTO ab — Output-Schema lebt nur in dieser Route, nicht in `shared/api`. |
| `GET /:customerId/allocations` | `getBudgetAllocations` | History | Roh-Liste |
| `GET /:customerId/transactions` | `getBudgetTransactions` | History | Filter via Query-Param `budgetType` |
| `GET /:customerId/preferences` | `getBudgetPreferences` | Settings | Legacy-Surface |
| `GET /:customerId/cost-estimate` | **Eigene Aggregations-Logik** (L62–241) über `serviceCatalogStorage`, `getAvailableForDate`, `getAllBudgetSummaries`, `getBudgetTypeSettings`, `formatEuroDE` | Overview-Hilfe für Forms | **Schwerster Drift-Hotspot.** Mischt Pricing, Budget-Verfügbarkeit, Warnungstext-Logik und VAT-Mathematik. Selbst-Zahler-Fast-Path doppelt im Server und Client. |
| `GET /:customerId/type-settings` | `getLatestBudgetTypeSettingsWithTransition` + Default-Merge (L298–326) | Settings | Eigenes Default-Auffüllen + Prioritäts-Renumbering in der Route |
| `GET /:customerId/initial-balances/:budgetType` | `getInitialBalanceAllocations` | Settings/History (§45b mischt!) | §45b liefert sowohl `initial_balance` als auch `carryover` — Liste mit zwei Bedeutungen |
| `POST /:customerId/initial-balance/:budgetType` | `upsertInitialBalanceAllocation` + ggf. `upsertBudgetPreferences` (Anpassung `budgetStartDate`) | Settings | Seiteneffekt auf Preferences nur für §45b — leicht zu übersehen |
| `GET /:customerId/initial-balance/:allocationId/usage` | **Direkter `db.select` + `COUNT(DISTINCT)`** auf `budget_transactions` (L427–435) | Settings/Audit | Einzige Stelle mit Raw-SQL-Aggregation außerhalb der Storage-Schicht |
| `DELETE /:customerId/initial-balance/:allocationId` | Direkter `db.transaction` + Soft-Delete + `clearLegacyInitialBalanceFromSettings` | Settings | Route enthält Transaktions-Choreographie — gehört in Storage |
| `POST /:customerId/carryover/entlastungsbetrag_45b` (Task #670) | `upsertCarryoverAllocation` | Settings | Schwester-Endpoint zu `initial-balance`; getrennte URL, gleiche Mathematik |
| `PUT /:customerId/type-settings` | `upsertBudgetTypeSettings` | Settings | Selbstzahler-§45b-Block (Task #705) |
| `POST /:customerId/initial-budget` | (Setup-Pfad) | Settings | Selbstzahler-§45b-Block (Task #705) |
| `GET /:customerId/rebook-preview` / `POST .../rebook` | `getRebookPreview`, `rebookDisabledBudgetTransactions` | History/Admin | Eigener Aggregations-Layer |

#### Weitere Routen, die Budget-Daten berühren

| Route | Wie | Bucket |
|---|---|---|
| `GET /api/admin/customers/:id/budgets` | `customerManagementStorage.getCustomerBudgetHistory` (Legacy `customer_budgets`-Historie) | Settings (Legacy) |
| `GET /api/customers/:id/details` | enthält Customer-Stammdaten inkl. `pflegegrad`/`billingType`/`acceptsPrivatePayment` — Input für viele §45a-/Selbstzahler-Berechnungen | (Cross-cutting) |
| `server/routes/admin/statistics/*` | Stats-V2-Aggregation für `BudgetStatsResponse` (Tabelle „Bewilligt/Genutzt/Forecast") | Overview-Aggregat (über mehrere Kunden) — *teilweise out-of-scope, aber relevant für Forecast-Diskussion* |

### 1.3 Startup-Migrations & Hintergrund-Jobs

| Stelle | Was | Drift-Hinweis |
|---|---|---|
| `server/startup/backfill-budget-historization.ts` | Legt partielle UNIQUE-Indexe an und backfilled `validFrom` mit Sentinel `1970-01-01` | Sentinel-Wert ist Special-Case in `upsertBudgetTypeSettings` (Task #608) — Wissen lebt in zwei Files |
| `server/startup/clear-45b-monthly-limits` | No-Op-Stub (Task #603) | Bewusst nicht-destruktiv — kann aber bei Re-Aktivierung Drift erzeugen |
| `syncCarryoverAndExpiry`-Aufrufe | Triggered bei jedem `/summary`, `/overview`, `getAvailableForDate`, `createCascadeConsumption` | Implizite Kopplung — keine Garantie, dass alle Read-Pfade synchronisieren |

### 1.4 Bewusste Asymmetrien (KEIN Bug, aber Mapping-Pflicht)

- `cap-calculator.netConsumedInRange`: zählt `consumption − reversal`, **ohne** `write_off`.
- `import-availability.netConsumedUpToDate`: zählt `consumption + write_off − reversal`.
- `consumption-engine.consumeFifo`: nutzt `consumption + write_off − reversal` für `totalNetConsumed`.
- `summary-queries.getBudgetSummary` (§45b): zählt `consumption + write_off − reversal` für `totalUsedCents`, plus separate Monats-Window-Aggregation.

→ Vier Aggregations-Definitionen für „Verbrauch", abhängig vom Aufrufpfad.

---

## 2. CLIENT-Inventar

### 2.1 Overview-Bucket

| Datei + Zeilen | Was wird gerendert | Quelle (Query-Key) | Re-Berechnung im Client? |
|---|---|---|---|
| `client/src/components/budget/BudgetLedgerSection.tsx` (L294–585) | §45b: Available-after-Planned, Planned, Total Allocated/Used, Carryover, Multi-Segment-Progress-Bar; §45a/§39: Monthly/Yearly Available, Limit, Used | `["budget-overview", customerId]` | **Ja**: L337 `Math.min(availableAfterPlanned, currentMonthAvailable)` für §45b-Anzeige; Prozentsätze für Multi-Segment-Bar |
| `client/src/pages/customer-detail.tsx` (L383–472) | Kompakte Pot-Übersicht mit Prozent-Bars für 45b/45a/39 | `["budget-overview", customerId]` | **Ja**: `Math.round((used/allocated)*100)` an 3 Stellen |
| `client/src/pages/admin/statistics/v2/budgets-page.tsx` (L70–185) | KPI-Tiles + Customer-Pot-Tabelle inkl. Forecast | `["budget-stats-v2", ...]` (eigene Stats-Route) | **Ja**: Utilization-%, Open-Cents = Allocated − Used |
| `client/src/features/appointments/components/cost-estimate-preview.tsx` | „Kosten / Verfügbar / Privat / Budget reicht nicht" | `["budget-cost-estimate", customerId, date, services]` | **Ja**: Verzweigung über `isHardBlock`, `privateCents`, `bruttoCents` — Wording-Logik parallel zum Server |

### 2.2 Settings-Bucket

| Datei + Zeilen | Was | Quelle | Re-Berechnung? |
|---|---|---|---|
| `client/src/components/budget/BudgetTypeSettings.tsx` | Pot-Konfiguration (enabled, priority, monthly/yearly Limit, validFrom/To, Initial-Balance-Liste, Carryover-Dialog) | `["budget-type-settings", customerId]`, `["initial-balances", customerId, type]`, `["budget-allocations", customerId]` | **Ja**: `parseEuroDE`/`Math.round(*100)` für Input → Cents; Transition-Hint via `effectiveToday`-Vergleich |
| `client/src/components/budget/PflegegradBudgetSection.tsx` | Pflegegrad-abhängige Budget-Historie (Legacy `customer_budgets`) | `["customer-budgets", customerId]` | **Ja**: zeigt Historie aus Legacy-Tabelle parallel zur neuen Settings-Sektion |
| `client/src/features/customers/components/wizard/budgets-contract-step.tsx` (L47–98, L239) | Setup-Wizard Budget-Step (max §45b-Validierung, Prorata-Carryover-Berechnung) | Lokaler Form-State | **Ja, eigenständig**: `BUDGET_45B_MAX_MONTHLY_CENTS/100` Vergleich, Prorata `months * 131`, Hint `maxCarryover - vorjahrVerbraucht` |
| `client/src/features/customers/hooks/use-customer-wizard.ts` (L360–368) | Mapper Form-Strings → Cents-Payload | Lokal | **Ja**: `Math.round(parseFloat(val)*100)` (raw, NICHT über `parseEuroDE`) |

### 2.3 History/Audit-Bucket

| Datei + Zeilen | Was | Quelle | Re-Berechnung? |
|---|---|---|---|
| `BudgetLedgerSection.tsx` (Transaction-List-Sub) | Liste aller `budget_transactions` mit Filter | `["budget-transactions", customerId, budgetType]` | Nein, reine Anzeige + Formatierung |
| `BudgetTypeSettings.tsx` (Initial-Balance-Section) | Startwert-/Carryover-Historie pro Pot | `["initial-balances", customerId, type]` | Nein, aber §45b mischt zwei Quellen in einer Liste |
| `BudgetTypeSettings.tsx` (Rebook-Section) | Anzeige der durch Pot-Deaktivierung betroffenen Transaktionen | `["budget-rebook-preview", customerId]` | Nein |

### 2.4 Cents↔Euro-Konversion (Hotspots)

- `formatEuroDE`, `centsToEuroNumber`, `parseEuroDE` aus `shared/utils/money.ts` werden überall verwendet **außer**:
  - `use-customer-wizard.ts:360` — direktes `Math.round(parseFloat(val) * 100)`.
  - `wizard/budgets-contract-step.tsx` — vereinzelte `toFixed(2)` / `/100`-Stellen für Anzeige in Hints.
  - `statistics/v2/budgets-page.tsx` — eigener `cents()`-Wrapper um `formatEuroDE`.

---

## 3. SHARED-Inventar

### 3.1 `shared/domain/budgets.ts`

| Symbol | Was | Wer nutzt |
|---|---|---|
| `BUDGET_45B_MAX_MONTHLY_CENTS = 13100` | §45b-Statut-Cap | Allocation, Cap-Calculator, Wizard, Settings-UI |
| `BUDGET_45A_MAX_BY_PFLEGEGRAD` | PG-abhängige §45a-Maxima | `clampToStatutoryMax`, Wizard, Settings-Validierung |
| `BUDGET_39_42A_MAX_YEARLY_CENTS = 353900` | §39+42a Jahres-Cap | Cap-Calculator, Validierung |
| `BUDGET_TYPES` | Pot-Enum | Schema, API, UI |
| `effectiveDefaultPots(customer)` | Default-Töpfe (Reihenfolge + anspruchs-gegateter `enabled`-Zustand) ohne persistierte type-settings-Zeile; einzige Default-Quelle (BUG-19 Facette A). Roh-Reihenfolge-Konstante `DEFAULT_BUDGET_POT_ORDER` ist modul-privat. | Consumption-Engine, Invoice-Split, Budget-Route (Read-Default) |
| `validate45bAmount` / `validate45aAmount` / `validate39_42aAmount` | Eingabe-Validierung | API + Form |
| `get45aMaxForPflegegrad` | Statutorischer §45a-Resolver | `clampToStatutoryMax` |
| `clampToStatutoryMax` | Zentrale Klemme an Cap | Cap-Calculator, Allocation-Storage |

### 3.2 `shared/domain/invoice-line-items.ts` (Budget-relevante Teile)

| Symbol | Was | Wer nutzt im Budget-Kontext |
|---|---|---|
| `quantizeKm(km)` | Kaufmännisch 2-NK-Quantisierung | Consumption-Engine (Task #616), Cost-Calculator |
| `computeKmLineTotalCents(km, rate)` | Quantisiertes km-Total in Cents | Cost-Calculator |
| `deriveQuantityRaw(unit, args)` | Persistierte Roh-Menge | Indirekt via Cost-Berechnung |

### 3.3 `shared/domain/budget-rebook-triggers.ts`

| Symbol | Was |
|---|---|
| `REBOOK_TRIGGERS` | Audit-Vokabular für `appointment_km_rebooked` (`appointment_edit:km_change`, `appointment_import:update`, …) |

### 3.4 `shared/utils/money.ts`

`centsToEuroNumber`, `formatEuroDE`, `parseEuroDE`. **Architecture-Test** (`tests/architecture/no-money-arithmetic-outside-helper.test.ts`) verbietet rohe Cents-Arithmetik außerhalb dieser Datei.

### 3.5 `shared/utils/datetime.ts` (Budget-relevant)

`todayISO`, `currentYearAndMonth`, `lastDayOfMonth`, `parseLocalDate`, `addDays`, `formatDateISO`. Werden in praktisch jedem Allocation-/Cap-/Settings-Pfad als Input verwendet — Berlin-Zeit-Diskussion lebt zentral hier.

### 3.6 `shared/schema/budget.ts` & `server/storage/budget/types.ts`

| Typ | Wo definiert | Wer konsumiert |
|---|---|---|
| `BudgetAllocation` / `InsertBudgetAllocation` | `shared/schema/budget.ts` | Allocation-Storage, Routes |
| `BudgetTransaction` / `InsertBudgetTransaction` | `shared/schema/budget.ts` | Consumption-Engine, History-UI |
| `CustomerBudgetPreferences` / `InsertBudgetPreferences` | `shared/schema/budget.ts` | Preferences-Storage |
| `CustomerBudgetTypeSetting` | `shared/schema/budget.ts` | überall historisierungs-relevant |
| `BudgetSummary` / `Budget45aSummary` / `Budget39_42aSummary` / `AllBudgetSummaries` | `server/storage/budget/types.ts` (**nicht in `shared/api`!**) | Summary-Queries, Route `/overview` |
| `BudgetTypeSettingWithTransition` | `server/storage/budget/preferences-storage.ts` | Route `/type-settings`, UI |
| Route-Output-Schema `/overview` | **Nur inline in der Route** (L243–280) | Client-`useQuery` ohne Type-Sharing |

→ **DTO-SSoT-Lücke**: Die Hauptkomponente der Overview liest ein Schema, das nirgendwo in `shared/api/` deklariert ist.

---

## 4. Konflikt-Matrix

| Kennzahl | Stellen, die sie berechnen | Inputs unterschiedlich? | Risiko |
|---|---|---|---|
| §45b „verfügbar" | (a) `summary-queries.getBudgetSummary.availableCents` (Gesamt), (b) `summary-queries.getBudgetSummary.currentMonthAvailableCents`, (c) `import-availability.getAvailableForDate.total45b` (zum Datum), (d) `cost-estimate`-Route mit `Math.min(...)`-UI-Wording | Ja: (a) cumulative bis heute, (b) Monatswindow, (c) bis `transactionDate`, (d) Mischung | **Hoch** — verschiedene Routen liefern verschieden große „verfügbar"-Zahlen |
| §45b „verbraucht" | `summary-queries.getBudgetSummary` (cumulative inkl. write_off), `cap-calculator.netConsumedInRange` (Monat ohne write_off), `import-availability.netConsumedUpToDate` (cumulative inkl. write_off), `consumeFifo.totalNetConsumed` (Window inkl. write_off) | Ja: write_off-Behandlung + Fensterlogik | **Hoch** — siehe 1.4 |
| §45b Allocation | `calculateAllocated45b` (virtual + IB + Carryover), `getBudgetSummary.totalAllocatedCents` (delegiert), `getBudgetSummary.currentYearAllocatedCents` (eigene Berechnung bis Jahresende vs. heute), Wizard `months * 131` | Teilweise: Wizard nutzt rohe Multiplikation | **Mittel** — Wizard kann statutorische Klemme verfehlen, wenn pflegegrad-/datums-spezifische Limits zukünftig kommen |
| §45a/§39 „verfügbar" | `summary-queries.getBudgetSummary45a/39_42a` (eigene Cap-Mathematik), `cap-calculator.computeCapSlot` (SSoT für Booking + Preview) | Ja: Summary-Pfad nutzt `computeCapSlot` NICHT | **Hoch** — Headerzahl in Overview kann von Buchungs-Cap abweichen |
| §45b „Monatsanteil" / „Unser Anteil" | `getMonthlyBudgetAmountCents` (Settings + Legacy `customer_budgets`-Fallback), `calculateAllocated45b` (per Monat über Historisierung), `BudgetTypeSettings.tsx` (UI-Input) | Ja: drei verschiedene Auflösungsmechanismen | **Mittel** — Legacy-Fallback ist die einzige `customer_budgets`-Lese-Stelle |
| Carryover | `getTotalCarryoverCents` (aktiv, kein Verbrauch), `getAvailableCarryoverCents` (aktiv minus Verbrauch), `ensureYearlyCarryover45b` (Auto-Schreibpfad), `upsertCarryoverAllocation` (Manuell-Schreibpfad), `BudgetTypeSettings.tsx` (UI-Anzeige der Historie) | Ja: Lese-Zahl ≠ Verfügbarkeits-Zahl | **Mittel** — UI muss korrekt zwischen „Carryover gesamt" und „Carryover-Rest" wählen |
| Geplante Kosten / Forecast | `getPlannedCostCents` (Termin-Summe), `BudgetSummary.availableAfterPlannedCents`, `statistics-v2.forecastYearEndCents` | Ja: drei Definitionen für „zukünftig" | **Mittel** — Forecast-Logik lebt parallel in Stats-Aggregator und Summary |
| Settings-Read | `getBudgetTypeSettings` (today), `getActiveBudgetTypeSettings(asOfDate)`, `getLatestBudgetTypeSettings`, `getLatestBudgetTypeSettingsWithTransition` | Ja: 4 Algorithmen für dieselbe Tabelle | **Hoch** — falscher Lookup im Booking-Pfad = GoBD-Bruch |
| Cost-Estimate-Logik | Server: `routes/budget.ts:cost-estimate` (~180 LOC inline Aggregator); Client: `cost-estimate-preview.tsx` (Wording-Logik) | Teilweise | **Mittel** — Wording („Budget reicht nicht — X privat") existiert doppelt |

---

## 5. Migrations-Vorschlag (Drei-View-Modell)

> Diskussionsgrundlage, **kein verbindlicher Plan**. Pro Pot eigene Migrations-Task in Phase 1+.

### 5.1 Ziel-Views

#### `BudgetOverviewView` (Read-Modell für Kunden-Hauptseite + Cost-Estimate + Stats-Tile)

Absorbiert:
- `summary-queries.getBudgetSummary` (alle drei Pots zusammen)
- `summary-queries.getBudgetSummary45a` / `getBudgetSummary39_42a` — als interne Helper unter einem gemeinsamen Aggregator-Hut
- `import-availability.getAvailableForDate` (gleicher Header, parametriert per `asOfDate`)
- Route `GET /budget/:id/overview` UND `GET /budget/:id/summary` (Konsolidierung; `/summary` deprecaten)
- Cost-Estimate-Route: die **Budget-Verfügbarkeits-Berechnung** zieht hierher; die **Pricing-Berechnung** bleibt eigene Domäne
- Stats-V2-Aggregator: wenn die Per-Customer-Werte aus dieser View kommen, wird die Statistik automatisch driftfrei

Ein DTO `BudgetOverviewDTO` in `shared/api/budget.ts` — heute liegt das Schema nur in der Route (Lücke).

#### `BudgetSettingsView` (Read- & Write-Modell für Pot-Konfiguration)

Absorbiert:
- `getBudgetTypeSettings`, `getActiveBudgetTypeSettings`, `getLatestBudgetTypeSettings`, `getLatestBudgetTypeSettingsWithTransition` → **eine** Read-API mit explizitem Modus (`forDate` / `forEdit` / `withTransition`)
- `getBudgetPreferences` / `upsertBudgetPreferences`
- `upsertBudgetTypeSettings`, `upsertInitialBalanceAllocation`, `upsertCarryoverAllocation`, `clearLegacyInitialBalanceFromSettings`
- `getInitialBalanceAllocations` (Mischung §45b initial+carryover als bewusste Pot-Eigenschaft beibehalten)
- Selbstzahler-Routing-Regeln (Task #705) als Shared-Validator
- Wizard `budgets-contract-step.tsx`: Validierung & Cents-Mapping wandert in einen Shared-Helper, damit Wizard und Settings dieselben Regeln nutzen

#### `BudgetHistoryView` (Read-Modell für Allocations + Transactions + Audit)

Absorbiert:
- `getBudgetAllocations`, `getBudgetTransactions`, `getTransactionByAppointmentId`, `getTransactionsByAppointmentId`
- `getRebookPreview`, `rebookSingleTransaction`, `rebookDisabledBudgetTransactions` (Read-Teil; Write-Teil bleibt eigener Service)
- `/initial-balance/:allocationId/usage` (Raw-SQL aus der Route hierher)
- `getAvailableCarryoverCents` (Pro-Allocation-Detail)

### 5.2 Grenzfälle / vierter View?

- **`BudgetForecastView`** (Task #704 in Vorbereitung): „availableAfterPlanned" + `getPlannedCostCents` + Stats-V2-`forecastYearEndCents` + §45b-Auto-Renewal-Projektion bis Jahresende. Heute auf 4 Stellen verteilt. Empfehlung: eigener View, weil andere temporale Semantik (Zukunft statt Gegenwart).
- **`BudgetBookingView` (Booking-Path)**: ist primär Write, nicht Read. Bleibt als Consumption-Engine bestehen, **muss aber explizit über `BudgetOverviewView.getAvailability(asOfDate)` und `BudgetSettingsView.getActive(asOfDate)` lesen** — das ist die heute fragile Stelle.
- **`customer_budgets` (Legacy-Tabelle)**: einzige verbleibende Leser sind `getMonthlyBudgetAmountCents` und `getCustomerBudgetAmounts` plus `PflegegradBudgetSection.tsx`. Empfehlung: Phase-1 oder -2 entscheiden, ob die Tabelle in `BudgetSettingsView` aufgeht oder als Read-Only-Historie in `BudgetHistoryView` bleibt.

### 5.3 Was bewusst NICHT absorbiert wird

- Pricing (`appointment-cost-calculator.ts`) — eigene Domäne, Budget konsumiert nur das Cents-Ergebnis.
- km-Quantisierung (`shared/domain/invoice-line-items.ts`) — Cross-Domain-Shared-Helper, bleibt zentral.
- Cap-Mathematik (`cap-calculator.ts`) — **muss** SSoT bleiben. Wird von `BudgetOverviewView` und der Booking-Engine konsumiert.

---

## 6. Review-Bereich — offene Fragen & Annahmen

1. **`customer_budgets` (Legacy)** — soll die Tabelle in Phase 1 abgeschaltet werden? Wenn ja: was passiert mit `PflegegradBudgetSection.tsx`, das die Historie rendert?
2. **Sentinel `1970-01-01`** in `customer_budget_type_settings.validFrom`: jetzige Maskierung lebt in UI + `upsertBudgetTypeSettings`. Zieht das in den `BudgetSettingsView` mit, oder lieber als Backfill-Bereinigung entfernen?
3. **§45b carryover-Quelljahr-Dedup** liegt heute doppelt (`ensureYearlyCarryover45b` und `upsertCarryoverAllocation`). Konsolidierung in `BudgetSettingsView` oder dedizierter `CarryoverService`?
4. **DTO-Lücke**: das `/overview`-Schema lebt nur in der Route. Phase 1 sollte den DTO nach `shared/api/budget.ts` heben — vor oder nach der Storage-Konsolidierung?
5. **Cost-Estimate-Route** (~180 LOC) mischt Budget + Pricing + Wording. Aufteilen in `pricing/estimate` (Cents) + `budget/availability` (Cents + Warnings)?
6. **`getBudgetSummary45a` / `getBudgetSummary39_42a`** rechnen Cap selbst statt `computeCapSlot` zu rufen. Soll Phase 1 das vor der View-Konsolidierung umstellen, oder als Teil der View?
7. **Selbstzahler-§45b-Block** (Task #705) lebt heute in zwei Routen (`/type-settings`, `/initial-budget`) plus Frontend. In `BudgetSettingsView` zentralisieren?
8. **Stats-V2 Forecast** — Teil der Phase-1-Konsolidierung oder eigener Phase-2-Schritt zusammen mit Task #704?
9. **`write_off`-Asymmetrie** (siehe 1.4) — bewusst lassen oder vereinheitlichen? Hat Audit-Folgen.
10. **Cross-Customer-Aggregate** (Stats-V2): per Kunde aus `BudgetOverviewView` ziehen oder eigene Batch-Read-Schicht?

---

## 7. Beschlüsse (Review-Runde 2026-05-28)

Querschnitts-Auflagen für alle neuen Services/Views:
- **(A) Pure Funktionen, kein eigener State.** Neue Services/Views haben keine eigene Persistenz, keinen eigenen Cache. Eingaben rein, Ausgaben rein — sonst entsteht die nächste Drift-Quelle.
- **(B) Strukturierte Outputs.** Validatoren liefern `{ ok: boolean, reasons: string[] }`, keine nackten Booleans. Sonst pflegen Frontend und Backend wieder eigene Fehlertexte und driften erneut.

| # | Frage | Beschluss | Owner-Phase | Auflagen |
|---|---|---|---|---|
| 1 | `customer_budgets` (Legacy) abschalten? | Nein in Phase 1 — Read-Only-Historie in `BudgetHistoryView`, Fallback aus `getMonthlyBudgetAmountCents` entfernen. Echte Abschaltung Phase 2. | 1.3 + 2 | **Vor Fallback-Entfernung SQL-Check:** Kunden ohne Settings-Eintrag aber mit alten `customer_budgets`-Daten würden sonst still mit 0 rendern. |
| 2 | Sentinel `1970-01-01` | Mitziehen, kein Backfill (GoBD-Spur). Helper-Funktion in `BudgetSettingsView`. | 1.1 | Sentinel **als exportierte Konstante**, kein freier `date < '2000-01-01'`-Vergleich in der Codebase. |
| 3 | §45b Carryover-Quelljahr-Dedup | Eigener `CarryoverService` unterhalb von `BudgetSettingsView`. | 1.1 | Service **muss pure sein** (Input: Quelljahr-Settings + Buchungen, Output: verfügbarer Carryover). Keine eigene Persistenz, kein eigener Cache. |
| 4 | DTO-Lücke `/overview` | Vor der Storage-Konsolidierung. Schema nach `shared/api/budget.ts` heben, Route umstellen. | 1.2 (Vorlauf) | **Snapshot-Test:** aktuelles Antwort-JSON gegen neues Schema validieren, bevor die Storage-Konsolidierung startet. |
| 5 | Cost-Estimate-Route aufteilen | Ja: `POST /pricing/estimate` (Cents) + `GET /budget/:id/availability?asOfDate=…` (Cents + Warnings). | 1.2 | **Alte Route nicht parallel betreiben.** Konsumenten umstellen und entfernen — sonst zwei Wahrheiten. |
| 6 | `getBudgetSummary45a/39_42a` Cap-Pfad | Als Teil von Phase 1.2 auf `computeCapSlot` umstellen. | 1.2 | **`computeCapSlot` muss vorher als pure Funktion in `shared/domain/budget/` liegen.** Nicht parallel zur View bauen. |
| 7 | Selbstzahler-§45b-Block | Shared-Validator in `shared/domain/budget/selbstzahler-rules.ts`. Frontend und Backend konsumieren denselben. | 1.1 | **Output strukturiert** (`{ ok, reasons: string[] }`), nicht nur boolean. |
| 8 | Stats-V2 Forecast | Phase 2, gemeinsam mit #704-Folgearbeit. | 2 | **#704-Stabilität ist expliziter Blocker für Phase 2** — sonst beginnt Phase 2 mit halbem Forecast-Modell. |
| 9 | `write_off`-Asymmetrie | **Audit-first statt Regel-first.** Inventur der ~5-10 betroffenen Call-Sites, Entscheidung pro Stelle dokumentieren, dann einheitliche Regel als Architecture-Test festschreiben. Buchhaltung bestätigt die Regel vor Codifizierung. | 1.2 (Audit) → 1.3 (Regel) | Audit-Ergebnis als Tabelle in dieses Dokument anhängen, bevor Regel-Code geschrieben wird. |
| 10 | Cross-Customer-Aggregate | Per Kunde aus `BudgetOverviewView`, dazu explizite Batch-Schicht `getOverviewBatch(customerIds[])`. | 2 | **Batch-Implementierung als einzelner SQL-Join**, nicht als Schleife über die Single-View. Architecture-Test: „`getOverviewBatch` macht maximal X Queries unabhängig von N". |

### Phasen-Reihenfolge (verbindlich)

1. **Phase 1.1 — `BudgetSettingsView`** (1-2 Wochen): 4 Settings-Read-Funktionen → eine API mit Modus `forDate` / `forEdit` / `withTransition`. Selbstzahler-Validator und `CarryoverService` ziehen mit. Sentinel-Konstante. Equality-Tests pro Aufrufer-Pfad als Migrations-Guard.
2. **Phase 1.2 — `BudgetOverviewView`** (1-2 Wochen, nach 1.1): DTO-Vorlauf, Cap-Konsolidierung auf `computeCapSlot`, Cost-Estimate-Aufteilung, `write_off`-Audit als Vorbereitung.
3. **Phase 1.3 — `BudgetHistoryView`** (~1 Woche, nach 1.2): Allocations/Transactions/Audit-Aggregation, `write_off`-Regel als Architecture-Test, `customer_budgets` als Read-Only-Historie.
4. **Phase 2** — `BudgetForecastView` (Blocker: #704), `customer_budgets`-Tabelle abschalten, Stats-V2-Batch-Read.

### Begleitende Doku-Auslagerung

Budget-spezifische Architecture-Decisions und Gotchas wandern aus `replit.md` nach [`docs/architecture/budget.md`](./architecture/budget.md). `replit.md` behält nur Pointer.

---

## 8. Phasen-Stand

### Phase 1.1 — `BudgetSettingsView` Read-Pfad (abgeschlossen)

Geliefert:
- **Eine Read-API** `readBudgetTypeSettings(customerId, mode)` in `server/storage/budget/preferences-storage.ts` mit drei Modi (`forDate` / `forEdit` / `withTransition`). Re-Export auch über `server/storage/budget-ledger.ts`. Alte 4 Wrapper sind `@deprecated`, bleiben bis 1.1-Abschluss bestehen.
- **Selbstzahler-Validator** `shared/domain/budget-selbstzahler-validator.ts` (Output `{ ok, reasons: string[] }`, Querschnitts-Auflage B). Backend nutzt ihn über den Helper `rejectIfSelbstzahler45b` in `server/routes/budget.ts`; die 6 alten Inline-Blöcke sind ersetzt. Frontend kann denselben Validator anziehen, sobald die UI-Surface der §45b-Karte angefasst wird.
- **§45b-Carryover-Dedup** `shared/domain/budget-carryover-dedup.ts` (`carryoverWindowFor`, `buildCarryoverDedupSets`). Manueller Pfad (`upsertCarryoverAllocation`) und Auto-Pfad (`ensureYearlyCarryover45b`) teilen sich denselben Quelljahr-Schlüssel.
- **Sentinel-Konstante** `shared/domain/budget-settings-sentinel.ts` (`SETTINGS_VALID_FROM_EPOCH`). Frontend-Maskierung und Backend-Backfill-Erkenner importieren denselben Wert.
- **Drift-Schutz**: `tests/equality/budget-settings-read-modes.test.ts` (SSoT-API === Legacy-Getter pro Modus, mit 3-Zeilen-Seed: alt geschlossen / aktiv / zukünftig) und `tests/architecture/budget-sentinel-uniqueness.test.ts` (Sentinel-String nur im SSoT-Modul; Whitelist für Roh-SQL-Backfill und policy-fremde Stub-Daten dokumentiert in-File).

Nicht enthalten (folgt in 1.2/1.3):
- Write-Pfad-Konsolidierung (`upsertBudgetTypeSettings`, Transition-Insert).
- `BudgetOverviewView`, `BudgetHistoryView`.
- Frontend-Übernahme des Selbstzahler-Validators in der §45b-Karte.

### Phase 1.2 — `BudgetOverviewView` (laufend, Task #720)

Geliefert in dieser Iteration:
- **DTO-SSoT** `shared/api/budget.ts` (`BudgetOverviewDTO`, `BudgetOverview45bDTO`, `BudgetOverview45aDTO`, `BudgetOverview39_42aDTO`). Schließt die in Abschnitt 3.6 dokumentierte „Wire-Shape lebt nur inline in der Route"-Lücke. Backend (`server/routes/budget.ts` `/overview`) ist explizit gegen den Typ annotiert; Frontend (`client/src/components/budget/BudgetLedgerSection.tsx`) konsumiert denselben Typ statt der bisher duplizierten Inline-Interface-Definition. Drift zwischen Wire und UI wäre jetzt ein Compile-Fehler.
- **Pure Cap-Mathematik** `shared/domain/budget/cap-math.ts` (`computeCapRemaining`, Querschnitts-Auflage A erfüllt: keine DB-Zugriffe, keine States, keine Defaults). Der bisherige Monolith `server/storage/budget/cap-calculator.ts:computeCapSlot` wird zum DB-Lader-Wrapper: er materialisiert `netUsedInWindowCents`, `carryoverCents` und `pflegegrad` aus der DB und delegiert die Klemm-/Cap-Logik an die pure Funktion. Damit teilen sich Buchung (`createCascadeConsumption`), Vorab-Prüfung (`getAvailableForDate`) und künftig Equality-Tests/Frontend-Forecast denselben Code-Pfad — die §45b/§45a/§39-Maxima können nicht mehr in zwei Stellen unterschiedlich geklemmt werden.
- **Drift-Schutz** `tests/equality/budget-overview-dto-shape.test.ts` (Topologie-Snapshot der `/overview`-Response gegen `BudgetOverviewDTO`). Toleranz 0 für Feld-Namen, Spot-Checks für nullable-Verhalten von `monthlyLimitCents` und `carryoverExpiresAt`.

Bewusst NICHT in dieser Iteration (Drift-Notiz für Folge-Task):
- **`getBudgetSummary45a` / `getBudgetSummary39_42a` auf `computeCapSlot` umstellen** — die beiden Summary-Pfade bauen ihre Cap-Mathematik aktuell direkt in `summary-queries.ts` nach. Der Rewire ist mechanisch klein, aber jede Equality-Test-Familie (`45a-cap.test.ts`, `39-42a-cap.test.ts`, `monthly-cap-display-vs-booking.test.ts`) muss vorher als Anker laufen und bestätigt grün sein. Mit den drei pre-existierenden Failures (TE-BIZ-18.1, Datums-Edit-Rebook, 45b-monthly-amount Szenario 2) wäre die Drift-Diagnose unsauber. Folge-Task soll diese Failures separat fixen und dann den Rewire mit Equality-Vergleich „vor/nach"-Snapshot durchführen.
- **`/cost-estimate`-Route in `POST /pricing/estimate` + `GET /budget/:id/availability` aufspalten** — die Route ist ~180 LOC und vermischt Pricing (`hauswirtschaftMinutes * rate`, `serviceIds`-Pfad), Selbstzahler-Routing (`isSelbstzahler` → früher Return) und Availability (`getAvailableForDate` + Shortfall/Privatzahlung). Die Aufteilung erfordert Frontend-Updates in `edit-appointment.tsx`, `use-new-appointment-form.ts` und `CostEstimatePreview` PLUS einen neuen Combined-Hook, damit kein Wasserfall zweier Sequence-Calls entsteht. Folge-Task: Hook-Composition zuerst, dann Route-Split mit alter Route als Compatibility-Shim für eine Iteration (zwingender Grund: e2e-smoke-Tests laufen gegen die alte URL).
- **Frontend-Übernahme des Selbstzahler-Validators** — bleibt Phase 1.1-Restposten.

### Phase 1.2 — `write_off`-Asymmetrie-Audit (Task #720)

Buchhalterische Bestätigung der Regel folgt in Phase 1.3 (`write_off` als Architecture-Test). Diese Inventur ist die Vorlage.

**Definition:** `write_off` ist eine pot-bezogene Korrektur (Verfall, manuelle Abschreibung verfallenen Carryovers). Sie ist KEIN Fenster-Consumption — eine Buchung im Mai 2026 mit Datum `2025-06-30` wegen Carryover-Verfall darf den Mai-2026-Buchungs-Cap nicht reduzieren.

| Call-Site | Datei + Zeile | Behandelt `write_off` als | Begründung / Konsequenz | Soll-Regel Phase 1.3 |
|---|---|---|---|---|
| Cap-Mathematik (Fenster-Cap) | `server/storage/budget/cap-calculator.ts:42-87,150-156` (jetzt via `shared/domain/budget/cap-math.ts`) | **NICHT als Used gezählt** | Korrekt. `netUsedInWindowCents = consumption - reversal` ohne `write_off`. Andernfalls würde ein Carryover-Verfall im Sommer das Fenster-Budget für Termine im selben Fenster künstlich blockieren. | **Bestätigt korrekt** |
| Allocation-Kumulativ-Summary | `server/storage/budget/summary-queries.ts:167-170` (`getBudgetSummary` §45b) | **Als Used gezählt** (`netUsedCents = consumption + writeOff + manualAdjustment - reversals`) | Korrekt für die Sicht „Was ist insgesamt aus dem Jahres-Topf raus": Verfall reduziert das Restguthaben, soll also in `availableCents` sichtbar sein. Ohne diesen Beitrag wäre der Verfall am 30.06. nicht im Topf-Rest abgebildet. | **Bestätigt korrekt** |
| Per-Allocation-Verbrauchsrechnung (Carryover) | `server/storage/budget/summary-queries.ts:`(`getAvailableCarryoverCents`) `transactionType IN ('consumption','write_off')` | **Als Used gezählt** | Korrekt. Der pro Carryover-Allokation berechnete Rest darf den auto-`write_off` (Verfallsbuchung) als Verbrauch sehen, damit `Math.max(0, alloc - consumed)` nicht doppelt einen schon abgeschriebenen Rest zeigt. | **Bestätigt korrekt** |
| Import-Availability (`getAvailableForDate`) | `server/storage/budget/import-availability.ts:28` | **Als Used gezählt** | Korrekt für die Sicht „Was kann ein Termin mit Buchungsdatum X noch konsumieren": eine vor X liegende `write_off`-Buchung hat das Guthaben tatsächlich entwertet. | **Bestätigt korrekt** |
| Consumption-Engine FIFO-Carryover | `server/storage/budget/consumption-engine.ts:163,208` | **Als Used gezählt** (in der Berechnung „wieviel ist von dieser Spezial-Allokation noch übrig") | Korrekt. Spiegelt dieselbe Allocations-pro-Stück-Logik wie `getAvailableCarryoverCents`. | **Bestätigt korrekt** |
| Allocation-Storage Aggregate | `server/storage/budget/allocation-storage.ts:1078,1105,1213` (`SUM` über `consumption/write_off/reversal`) | **Alle drei aggregiert** | Korrekt für Anzeige-Aggregate à la „Topf-Bewegungen". Hier zählen alle drei Buchungstypen. | **Bestätigt korrekt** |
| Idempotente Verfalls-Schreibung | `server/storage/budget/allocation-storage.ts:1190,1238,1246` (`processExpiredCarryover` schreibt `write_off`, partielle UNIQUE schützt vor Doppel-Schreiben) | **Ist die Schreib-Stelle**, nicht Lese-Konsument | Schreibt einen einzigen `write_off` pro verfallener Allokation. UNIQUE-Index `(customer_id, allocation_id) WHERE transaction_type='write_off'` schützt vor Doppel-Buchung beim parallelen Sync. | **Bestätigt korrekt** |
| Conservation-Verifier (I13, Task #895 → #1298) | `server/lib/budget-conservation.ts` (`computePotConservation`) liest seit Task #1298 Verfügbarkeit/NettoKonsum **ausschließlich** über `readUnifiedBudgetAvailability` (SSoT) — keine eigene `write_off`-Klassifizierung mehr | **Vom Reader gekapselt** | Korrekt. Die No-Overdraw-Invariante wird projektions-bewusst gegen die App-Reader-Verfügbarkeit geprüft (allocated − consumedNet je Topf). Die write_off-Asymmetrie liegt jetzt vollständig im Reader (§45b allocation-view via `netConsumedUpToDate`, §45a/§39 Fenster-Cap-Sicht). Datei daher NICHT mehr in der `write_off`-Allowlist. Read-only; genutzt vom Migrations-Guard (Pre-/Post) und dem CLI-Verifier. | **Bestätigt korrekt** |
| §45b FIFO-Aufschlüsselung (Task #1129) | `server/storage/budget/fifo-breakdown.ts` (`transactionType IN ('consumption','write_off')` für den Übertrags-Verbrauch pro Carryover-Allokation) | **Als Used gezählt** | Korrekt. Die read-only-Visualisierung spiegelt exakt die Pro-Allocation-Sicht von `getAvailableCarryoverCents` (Topf-/Allocation-Sicht): ein `write_off` hat den Übertrags-Topf entwertet und zählt als Verbrauch. Verteilt nur die SSoT-Summen FIFO auf die zwei Töpfe, keine eigene Cap-/Fenster-Mathematik. | **Bestätigt korrekt** |

**Beschluss:** Die Asymmetrie ist nicht zufällig, sondern modelliert zwei Sichten korrekt:

> **Regel:** `write_off` zählt in der **Topf-/Allocation-Sicht** als Used (es ist Geld, das aus dem Topf raus ist), aber NICHT in der **Fenster-Cap-Sicht** (es ist keine Termin-Konsumption im Fenster).

Phase 1.3 hebt diese Regel als Architecture-Test fest (Test scannt nach `transactionType IN (...)`-Listen und gleicht gegen eine Allowlist pro Datei ab), damit eine neue Call-Site sich aktiv für eine Sicht entscheiden muss.

### Phase 1.3 — `BudgetHistoryView` (abgeschlossen, Task #727)

Geliefert in dieser Iteration:
- **Pure Monats-Aggregation** `shared/domain/budget/history-aggregation.ts` (`aggregateHistoryByMonth`, Querschnitts-Auflage A erfüllt: keine DB-Zugriffe, keine Defaults). Output pro Monatsbucket exponiert BEIDE Sichten explizit: `netUsedAllocationCents` (Topf-Sicht, inkl. `write_off`/`manual_adjustment`) UND `netUsedWindowCents` (Fenster-Cap-Sicht, ausschließlich `consumption − reversal`). Damit muss eine UI sich aktiv für eine Sicht entscheiden — ein dritter, drifteanfälliger „kombinierter" Used-Wert kann nicht versehentlich entstehen.
- **DB-Lader-Wrapper** `server/storage/budget/history-aggregation.ts` (`getMonthlyHistory`). Einzige Stelle, die `budget_transactions` für die History-Sicht roh liest, delegiert die Aggregation an die pure Funktion. Re-Export über `server/storage/budget-ledger.ts`.
- **Konsolidierter Endpunkt** `GET /api/budget/:customerId/history?from=&to=&budgetType=` (`checkCustomerAccess`, mirror von `/overview`). Frontend/Equality-Tests konsumieren denselben Aggregat-Output statt eigener Filter über `/transactions`.
- **Drift-Schutz Equality** `tests/equality/budget-history-vs-overview.test.ts` (Random-Customer + §45b-Szenario mit Initial-Balance, 2 dokumentierten Terminen, 1 Reversal, 1 Manual-Adjustment): `SUM(history.netUsedAllocationCents, §45b) === overview.entlastungsbetrag45b.totalUsedCents`. Wenn jemand künftig in `getBudgetSummary` oder `aggregateHistoryByMonth` eine Buchungs-Typ-Klassifizierung verschiebt, schlägt der Test mit der konkreten Differenz fehl.
- **Drift-Schutz Architecture** `tests/architecture/budget-write-off-classification.test.ts`: scannt Server- und Shared-Code nach `'write_off'`-Treffern in `transactionType`-Kontext und gleicht gegen eine Allowlist pro Datei (mit Sicht-Klassifizierung) ab. Neue Call-Sites müssen sich aktiv eintragen UND die Audit-Tabelle in §1.4 ergänzen — die in §7 Beschluss #9 verlangte „Audit-first statt Regel-first"-Disziplin ist damit ab jetzt automatisiert geschützt.

Bewusst NICHT in dieser Iteration (Phase 2):
- **`customer_budgets`-Fallback aus `getMonthlyBudgetAmountCents` entfernen.** Beschluss #1 verlangt vor der Entfernung einen SQL-Check (Kunden ohne Settings-Eintrag, aber mit alten `customer_budgets`-Daten würden sonst still mit 0 rendern). Die Tabelle bleibt vorerst Read-Only-Historie. Bewusste Phase-2-Aufgabe gemeinsam mit der echten Tabellen-Abschaltung.
- **`getInitialBalanceAllocations` / Allocation-Listen in den `BudgetHistoryView`-Endpunkt ziehen.** Die aktuelle History-Aggregation deckt den Transaktionsteil der Sicht ab; Allocation-/Audit-Joins folgen, sobald die Frontend-Umstellung der History-UI (`BudgetLedgerSection.tsx`) angesetzt wird. Die Aggregations-SSoT steht bereits — eine Erweiterung des DTO ist additiv, ohne Drift-Risiko.

### Phase 2 — freigeschaltet

Mit Abschluss der drei Read-Views (Settings, Overview, History) und der `write_off`-Architecture-Schranke ist Phase 2 freigeschaltet:
- `BudgetForecastView` (Blocker: Task #704-Stabilität).
- `customer_budgets`-Tabelle abschalten (SQL-Pre-Check + Fallback-Removal in `getMonthlyBudgetAmountCents`/`getCustomerBudgetAmounts`, danach `PflegegradBudgetSection.tsx` als Read-Only-Historie auf den History-Endpunkt umstellen).
- Stats-V2-Batch-Read (`getOverviewBatch(customerIds[])`, Architecture-Test: max. X Queries unabhängig von N).

### Phase 2.1 — `customer_budgets` als Read-Quelle abgeschaltet (abgeschlossen, Task #728)

Geliefert in dieser Iteration:
- **Backfill** `server/startup/backfill-customer-budgets-to-typesettings.ts` (idempotent, Roh-SQL `INSERT ... WHERE NOT EXISTS`). Mappt pro Kunde die LATEST `customer_budgets`-Zeile auf SSoT-Einträge in `customer_budget_type_settings`: `entlastungsbetrag45b → entlastungsbetrag_45b.monthly_limit_cents`, `pflegesachleistungen36 → umwandlung_45a.monthly_limit_cents`, `verhinderungspflege39 → ersatzpflege_39_42a.yearly_limit_cents`. `valid_from` aus der Quellzeile, Sentinel `'1970-01-01'` als Fallback (Sentinel-Whitelist erweitert). Beträge mit 0/NULL werden übersprungen. Bestehende SSoT-Zeilen pro (customer_id, budget_type) bleiben unangetastet — Backfill ist additiv und GoBD-konform.
- **Read-Fallback entfernt** `server/storage/budget/allocation-storage.ts`: `getMonthlyBudgetAmountCents` und `getCustomerBudgetAmounts` lesen jetzt ausschließlich aus `customer_budget_type_settings`. Kunden ohne Setting fallen auf den gesetzlichen Default (45b) bzw. 0 (45a/39_42a) zurück — kein stiller `customer_budgets`-Read mehr. Drizzle-Import von `customerBudgets` aus der Datei entfernt.
- **Schreibpfad No-Op** `server/storage/customer-mgmt/budgets.ts:addCustomerBudget` ist jetzt Stub (log warning + synthetischer Return), damit Legacy-Caller (`server/lib/customer-creation-helpers.ts`, `server/routes/admin/customers/budgets.ts`) kompilieren und ohne Crash returnen, ohne dass die eingefrorene Tabelle weiter beschrieben wird. SSoT-Writer bleibt `budgetLedgerStorage.upsertBudgetTypeSettings`. Read-Helper (`getCustomerCurrentBudget`, `getCustomerBudgetHistory`) bleiben als `@deprecated`-Audit-Pfad bestehen — die Tabelle wird in einer späteren Phase gedroppt.
- **Drift-Schutz Architecture** `tests/architecture/no-customer-budgets-reads.test.ts`: scannt `client/src`, `server`, `shared`, `scripts` nach `customerBudgets`/`customer_budgets` und blockt neue Aufrufer mit per-Datei-Allowlist. Die Allowlist deckt Schema-Definition, Audit-Read-Helper, No-Op-Writer, Test-Cleanup, Maintenance-Skripte und den neuen Backfill ab — neue Konsumenten müssen sich aktiv eintragen.
- **Migration-Test** `tests/budget/customer-budgets-backfill.test.ts`: 3 Szenarien — (A) Vollständiges Mapping aller drei Töpfe mit korrekter Spalten-Zuordnung und `validFrom`, (B) Idempotenz: zweiter Lauf erzeugt keine neue Zeile, (C) Bestehende SSoT-Zeile pro Topf wird NICHT überschrieben (andere Töpfe werden trotzdem migriert).

Drift-Notiz für Folge-Tasks (nicht in dieser Iteration):
- `PflegegradBudgetSection.tsx` liest `careLevelHistory` (Pflegegrad-Verlauf), NICHT `customer_budgets` — der Frontend-Bullet aus dem ursprünglichen Task-Plan war redundant. Keine Aktion nötig.
- Admin-POST `/admin/customers/:id/budgets` antwortet weiterhin `201` mit synthetischem Stub-Body. Die Route bleibt im Tree, sollte aber in einer Folge-Iteration entweder gelöscht oder auf `upsertBudgetTypeSettings` umgezogen werden, sobald der Operator-Workflow geklärt ist. Aktuell hat sie keinen Frontend-Konsumenten.
- `getCustomerCurrentBudget` wird in `getCustomerWithDetails` als `customer.budget` weitergegeben (Read-Only-Snapshot der eingefrorenen Tabelle). Frontend nutzt das Feld aktuell nicht; mit dem Tabellen-Drop in der nächsten Phase entfällt der Snapshot ersatzlos.

### Phase 6 — SSoT-Konsolidierung abgeschlossen (Endzustand, Task #876)

Phase 6 verriegelt den in #728/#743 vorbereiteten Endzustand und schließt die Route-Folds (#108) ab. Es wurde **keine** neue Budget-Funktion gebaut und §45b NICHT materialisiert (bleibt Phase 2).

- **Serving zu 100 % auf dem unified Reader:** Die letzten beiden Serving-Caller der Legacy-Summary-Reader wurden auf die `*Served`-Varianten umgestellt — `getBudgetSummaryServed` in der Termin-Serien-Verlängerung (`server/routes/appointment-series.ts`) und `getAllBudgetSummariesServed` im Kostenschätzungs-Pfad (`server/routes/budget.ts`). Damit ist `getAvailableForDate`/`readUnifiedBudgetAvailability` die **einzige** `Available`-SSoT im Serving; `getBudgetSummary*`/`getAllBudgetSummaries` (ohne `Served`) leben nur noch als Shadow-/Equality-Baseline.
- **Architektur-Schranke aktiv:** `tests/architecture/no-customer-budgets-reads.test.ts` (camelCase `customerBudgets` case-sensitiv + SQL-DML `(from|join|into|update) customer_budgets` case-insensitiv über `server`/`client/src`/`shared`; Allowlist = nur der DDL-/Drop-Migrationspfad). Neue `customer_budgets`-Leser werden geblockt.
- **Route→Storage-Folds (#108):** Keine direkte `db.*`-Choreographie mehr in `server/routes/budget.ts` (In-Place-§45a/§39-Aktivierung → `preferences.ensureBudgetTypeEnabledInPlace`) und `server/routes/admin/customers/budgets.ts` (Kategorie-Resolve → `resolveDominantServiceCategories`, System-Signatur-Write → `markAppointmentSystemSigned`).
- **Akzeptierte §45a/§39 vs. §45b-Divergenz:** Auf §45a/§39 rechnen Legacy-Summary-Reader und unified Reader identisch (Δ0); nur §45b weicht erwartungsgemäß ab (Legacy all-time vs. unified as-of + `manual_adjustment`). Keine Reparatur der Legacy-Mathematik — Auflösung erst mit §45b-Materialisierung (Phase 2). Begründung + IKS-Liste: [`docs/architecture/budget-verfahrensdokumentation.md`](architecture/budget-verfahrensdokumentation.md). (Die ursprüngliche Shadow-Read-Soak-Verifikation [Gate I18] wurde nach dem Drop der `customer_budgets`-Tabelle als toter Code entfernt.)
- **Verbleibend für Phase 2:** §45b-Materialisierung, physischer Drop der `customer_budgets`-Tabelle (DDL), `BudgetForecastView`, Stats-V2-Batch-Read.
