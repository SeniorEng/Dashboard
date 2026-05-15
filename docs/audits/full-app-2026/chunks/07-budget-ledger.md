# Chunk 7 — Budget-Ledger

**Tiefenstufe:** Deep-Audit (Subagent-Lauf, alle 3 Phasen)
**Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Risiko:** HOCH
**LOC / Files:** 6 260 / 18

## Geprüfte Dateien

`server/routes/budget*.ts`, `server/storage/budget/**`, `server/startup/*budget*.ts`,
`client/src/components/budget/**`.

## Findings

### KRITISCH

1. **`server/storage/budget/consumption-engine.ts:264` — Fehlender Advisory-Lock
   in `createCascadeConsumption`.**
   `createConsumptionTransaction` hat den `pg_advisory_xact_lock`, aber
   `createCascadeConsumption` (direkt aufgerufen z. B. von
   `rebookDisabledBudgetTransactions`) nicht. Bei paralleler Massen-Rebooking-
   Action kann derselbe Topf doppelt verbraucht werden.
   **Fix:** `pg_advisory_xact_lock` in `doWork`-Block von
   `createCascadeConsumption` ziehen, damit ALLE Einstiegspunkte serialisiert
   sind.

### HOCH

2. **`shared/domain/budgets.ts:167` — Silent §45a-Clamp bei fehlender
   Pflegegrad.**
   `clampToStatutoryMax` setzt §45a auf 0 €, wenn `pflegegrad < 2` oder fehlt.
   Legal korrekt, aber Buchung wirkt für Mitarbeiter unmotiviert „fehlgeschlagen".
   **Fix:** Im Clamp-Pfad einen `clamp_pflegegrad_missing`-Audit-Eintrag schreiben
   und im UI als spezifischen Fehler („Kein Pflegegrad ≥ 2 hinterlegt") anzeigen.

### MITTEL

3. **Legacy `monthlyLimitCents` auf §45b-Settings.**
   `cap-calculator.ts:160` setzt §45b-Cap-Remaining auf `+Infinity` (korrekt
   nach Task #425 — keine monatlichen Caps für §45b), aber alte Datensätze in
   `customer_budget_type_settings` mit `monthlyLimitCents > 0` für §45b könnten
   im Preview-UI verwirren. **Fix:** Einmalige Migration, die für
   `budgetType = entlastungsbetrag_45b` das `monthlyLimitCents`-Feld NULLt;
   im Read-Pfad ignorieren.

4. **`server/routes/budget.ts:426-440` — Redundanter Audit-Eintrag bei
   Initial-Balance-Resurrection.**
   `initial_balance_deleted` + `budget_allocation_soft_deleted` werden beide
   geschrieben → Audit-Lärm. **Fix:** Konsolidieren auf ein Event mit klaren
   Metadaten (`reason: "initial_balance_replaced"`).

5. **`server/storage/budget/consumption-engine.ts:55` — `subtract-last`-Residue
   verifiziert.**
   Verhindert Rundungsdrift zwischen Legs (HW/AB/Travel) und Gesamt
   (Task #441). **Kein Fix nötig.**

### NIEDRIG

6. **`server/storage/budget/allocation-storage.ts:307` — §45b virtuelle
   Allokation horizontiert korrekt.** Kein Fix.

7. **`server/storage/budget/consumption-engine.ts:123` — FIFO-Carryover-First
   per `CASE`-`ORDER BY`.** Kein Fix.

8. **`server/storage/budget/rebook-storage.ts:28` — Lock-Namespace identisch
   zur Booking-Path.** Kein Fix.

9. **`server/startup/backfill-budget-historization.ts` — idempotent.** Kein Fix.

10. **`server/storage/budget/preferences-storage.ts:242` — Transition-Audit
    erfasst Vorher/Nachher.** Kein Fix.

## Architect-Bewertung

Der Budget-Ledger ist konzeptionell und implementatorisch stark; das eine
KRITISCH-Finding (Cascade ohne Lock) ist eine ernsthafte Race-Surface, aber
nur durch nicht-User-Pfade (Massen-Rebooking) erreichbar — daher
realistisches Exploit-Risiko niedrig, aber Datenintegrität betroffen.

**Empfohlene Folge-Tasks:** 3.
