# Chunk 7 — Budget-Ledger (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep (Subagent-Code-Walk + Test-Reproduktion)
**Skills:** Database · Business-Logic · Regression-Guard · QA

## Befunde

### KRITISCH-1 — km-Rebook-on-Edit-Regression
- **Fundstelle:** `server/storage/budget/km-rebook.ts` + Appointment-`PATCH`-Pfad
- **Symptom:** Cluster aus 6 Test-Files schlägt **deterministisch** fehl, auch isoliert
  reproduziert (`tests/budget/km-rebook-on-edit.test.ts`: `stillLinkedOld` = 1, erwartet 0;
  jede mit test-eigener `appointmentId` → **keine** Shared-DB-Flake):
  - `tests/equality/appointment-edit-rebook.test.ts` (km-/Datums-/Service-Minuten-Edit)
  - `tests/equality/appointment-series-bulk-rebook.test.ts`
  - `tests/equality/appointment-series-exception-rebook.test.ts`
  - `tests/budget/km-rebook-on-edit.test.ts`
  - `tests/integration/audit-appointment-budget-km-drift-detects-drift.test.ts`
  - `tests/integration/reconcile-km-drift-leaves-audit-empty.test.ts`
- **Vertragsbruch:** Nach `reopen` + km-`PATCH` bleiben alte Consumption-Zeilen mit dem
  Termin verknüpft, obwohl der Test-Vertrag eine Entkopplung (`appointmentId=null`) erwartet,
  damit der Cascade-Pre-Check keine Dup-Konflikte sieht. Die system-eigene km-Drift-Detektion
  feuert ebenfalls → Doppelzählungs-/GoBD-km-Drift-Risiko gegen gesetzliche Caps.
- **Zusatzbefund:** Reversal-Insert `km-rebook.ts:206` ohne `onConflictDoNothing()` →
  Retry eines Edits kann trotz Unique-Index mit 500 brechen.
- **Effort:** M · **Folge-Task:** T-822-BUDGET-01

### NIEDRIG-1 — Reversal nutzt todayISO statt Originaldatum
- `server/storage/budget/transaction-storage.ts:117` — `reverseBudgetTransaction` nutzt
  `todayISO()` statt `orig.transactionDate`; bei monatsübergreifendem Storno kann das
  Cap-Fenster verzerrt werden. Effort S.

## Positive Confirmations (durch Code-Walk verifiziert)
- **Advisory-Locks durchgängig:** `createCascadeConsumption`, `createConsumptionTransaction`,
  `rebookSingleTransaction`, `rebookDisabledBudgetTransactions` nutzen alle
  `pg_advisory_xact_lock(hashtext('budget_consumption_'||customerId))` — der vormalige
  KRITISCH-Race (Vorgänger K6) ist **behoben**.
- **Cascade-Order SSoT:** `shared/domain/budgets.ts` (§45b → §45a → §39/42a).
- **Cap-SSoT:** `computeCapSlot` als gemeinsamer Eintritt für Anzeige und Buchung.
- **Erstberatung:** Budget-Buchung explizit übersprungen (`appointment-documentation.ts:122`).
- **Historisierung:** `budget_allocations` no-resurrect; `customer_budget_type_settings`
  append-only; Reversal-Zeilen behalten `appointmentId` (GoBD-CHECK).
- **Numeric statt real** für km-Spalten (`numeric(10,3)`).
