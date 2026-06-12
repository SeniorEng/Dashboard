# Budget-Ledger Referenz-Analyse (Paket 1.1 — Vorprüfung)

> **Status: NO-GO für die Tabellen-Löschung. Rückfrage an Alrik erforderlich.**
> Read-only-Analyse vom 12.06.2026. Keine Code-/Schema-/Test-Änderung.
> Grundlage für die nachgelagerte Umsetzungs-Aufgabe „Budget-Transactions
> härten, Ledger entfernen" — diese bleibt blockiert, bis Alrik entschieden hat.

## Frage

Paket 1.1 wollte `budget_ledger`, `budget_reservations` und `budget_migrations`
entfernen und die GoBD-Unveränderbarkeit direkt auf `budget_transactions`
erzwingen — unter der Annahme, dies seien tote/giftige Schatten-Tabellen neben
`budget_transactions`. Diese Analyse prüft je Referenz, ob das stimmt.

## Wichtigste Erkenntnis (Stolperfalle bestätigt)

Die **Fassade** `budgetLedgerStorage` (`server/storage/budget-ledger.ts`,
Interface `BudgetLedgerStorage`) ist die zentrale Budget-Fassade und wird an
**~90 Stellen** importiert (Routes, Services, Startup, Skripte). Sie ist
**NICHT** die `budget_ledger`-TABELLE. Naive Greps nach „budgetLedger"
vermischen beides. Diese Analyse zählt ausschließlich **echten
Tabellen-Zugriff** (Drizzle `.from/.insert/.update/.delete` auf den
Schema-Objekten `budgetLedger` / `budgetReservations` / `budgetMigrations` bzw.
rohes SQL auf den Tabellennamen).

Der echte Tabellen-Fußabdruck ist klein — aber **produktiv und nicht durch
`budget_transactions` ersetzbar**: alle drei Tabellen tragen eine andere
Funktion als der Consumption-Ledger `budget_transactions`.

---

## Tabelle: `budget_reservations` — **PRODUKTIV (Lesen bei jeder Verfügbarkeit) → NO-GO**

Operative Holds (Phase 5, „BUDGET_HARD_HOLDS"). Bewusst **nicht** GoBD,
mutierbar (State `hold | captured | released | expired`), aus Finanz-Exporten
ausgeschlossen — also kein Duplikat des Consumption-Ledgers.

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts:217` | Definition | Tabellendeklaration + Insert-Schema/Typen (`:260,268`). |
| `server/storage/budget/unified-reader.ts:52-71,216,270,305` `activeHoldsCents()` | **produktiv-lesend (ungated!)** | Der **eine** Verfügbarkeits-Reader (`readUnifiedBudgetAvailability`) liest `budget_reservations WHERE state='hold'` bei **jeder** Verfügbarkeitsberechnung für **alle drei** statutarischen Töpfe (§45b/§45a/§39+§42a). Läuft unabhängig vom Feature-Flag — ohne Holds liefert die Aggregation 0, das SELECT läuft trotzdem. Tabelle weg ⇒ jeder Budget-Read bricht. |
| `server/storage/budget/reservation-storage.ts` (gesamtes Modul) | produktiv-schreibend (flag-gated) | `planHold/captureHolds/releaseHolds/rescheduleHold/sweepOrphanHolds` schreiben/mutieren Holds. Aktiv bei `BUDGET_HARD_HOLDS` (siehe unten). |
| `server/lib/budget-conservation.ts:118-119` | produktiv-lesend | `leftJoin(budgetLedger …)` für den Orphan-`captured`-Kreuzcheck (Invariante I13). |
| `tests/budget/hard-holds-engine.test.ts`, `tests/budget-ledger-immutability.test.ts` | Test | Direkter Engine-/Trigger-Test. |

**Go/No-Go:** **NO-GO.** Nicht durch `budget_transactions` ersetzbar — Holds sind
ein eigenes operatives Konzept (geplant/noch nicht verbraucht) und werden auf
dem **Lesepfad jeder Budget-Verfügbarkeit** abgefragt.

---

## Tabelle: `budget_ledger` — **PRODUKTIV (Lesen + Schreiben) → NO-GO**

GoBD-immutable, append-only Finanz-Schicht (`consumed | reversed`). Ziel der
Hard-Hold-**Capture** und Quelle der Conservation-/Invarianten-Prüfungen.

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts:178` | Definition | Tabelle + Insert-Schema/Typen (`:250,257`); FK `budget_reservations.capturedLedgerId → budget_ledger.id` (`:237`). |
| `server/storage/budget/reservation-storage.ts:485,508,514-516` `captureHolds` | **produktiv-schreibend (flag-gated)** | `.insert(budgetLedger)` schreibt `consumed`-Zeilen beim Capture; Idempotenz-Re-Read `.from(budgetLedger)`. |
| `server/lib/budget-conservation.ts:118,128-129` `checkBudgetConservation` | **produktiv-lesend** | `leftJoin(budgetLedger)` + `reversesLedgerId`-Ketten-Integrität. **Konsumenten:** (1) CLI `verify-budget-conservation.ts` / `report-budget-exposure.ts` (prod-runnable), (2) `server/lib/invariants.ts:238` → HTTP-Route `GET /api/admin/invariants-report` (`server/routes/admin/invariants.ts`), (3) `budget-migration-runner.ts:166,170` Pre-/Post-Guard um **jede** budgetdaten-mutierende Startup-Migration. |
| `server/lib/invariants.ts:587,596,608` `checkBudgetLedgerConsistency` | produktiv-lesend (indirekt) | Result-Feld `budgetLedger`; Tabellen-Zugriff über `checkBudgetConservation`. Über SuperAdmin-Report-Endpoint erreichbar. |
| `server/startup/ensure-budget-ledger-immutability.ts` | produktiv (DDL + Self-Check) | Legt bei jedem Boot die GoBD-BEFORE-Trigger (UPDATE/DELETE/TRUNCATE) auf `budget_ledger` an; Laufzeit-Verifikation unter `/api/health → budgetLedgerImmutability`. |
| `tests/budget-ledger-immutability.test.ts`, `tests/budget/hard-holds-engine.test.ts`, `tests/architecture/budget-ledger-write-path.test.ts`, `tests/invariants/invariant-suite.test.ts` | Test | Immutability-, Engine- und Write-Path-Architektur-Tests. |

**Go/No-Go:** **NO-GO.** `budget_ledger` ist das GoBD-immutable Capture-Ziel der
Hard-Hold-Engine **und** die Datenquelle der Conservation-/Invarianten-Checks.
Es läuft **parallel** zu `budget_transactions` (Legacy-SSoT für ConsumedNet) —
ein Wegfall ist keine Dead-Code-Löschung, sondern ein **Rückbau der
Hard-Hold-Funktion**.

---

## Tabelle: `budget_migrations` — **PRODUKTIV (operatives Migrations-Bookkeeping) → NO-GO**

| Datei → Pfad/Funktion | Urteil | Beweis |
|---|---|---|
| `shared/schema/budget.ts` (`budgetMigrations`) + `server/startup/ensure-migration-ledger.ts` | Definition (Doppel-Quelle, by design) | Drizzle-Modell + rohes `CREATE TABLE … budget_migrations`; Drift-Test `tests/startup/migration-ledger-schema-drift.test.ts`. |
| `server/startup/budget-migration-runner.ts:106,116` | **produktiv-lesend + -schreibend** | `SELECT 1 FROM budget_migrations WHERE name = …` (genau-einmal-Guard) + `INSERT INTO budget_migrations …` innerhalb der Migrations-Tx. Läuft bei jedem Boot. |
| `server/startup/purge-junk-master-data.ts:250,340` | **produktiv-lesend + -schreibend** | Eigener genau-einmal-Guard (`SELECT 1 FROM budget_migrations …` + `INSERT INTO budget_migrations …`), unabhängig vom Migrations-Runner. |

**Go/No-Go:** **NO-GO.** Funktional orthogonal zu `budget_transactions` — reines
„welche einmalige Budget-Migration ist schon gelaufen?". Wegfall ⇒ jede
geguardete Migration läuft bei jedem Boot erneut. Nicht ersetzbar.

---

## Gesamtempfehlung

| Tabelle | produktiv-lesend | produktiv-schreibend | durch `budget_transactions` ersetzbar | Urteil |
|---|---|---|---|---|
| `budget_reservations` | **ja (ungated, jeder Read)** | ja (flag-gated) | nein | **NO-GO** |
| `budget_ledger` | **ja** | ja (flag-gated) | nein | **NO-GO** |
| `budget_migrations` | ja | ja | nein | **NO-GO** |

Die harte Stopp-Bedingung der Analyse ist **erfüllt**: alle drei Tabellen haben
produktive Lesepfade, die **nicht** durch `budget_transactions` (oder eine
andere bestehende Tabelle) ersetzbar sind. Die Annahme „tote/giftige
Schatten-Tabellen" trifft nicht zu.

## Entscheidender Kontext: BUDGET_HARD_HOLDS ist in PRODUKTION aktiv

`budget_ledger` + `budget_reservations` bilden die Phase-5-Hard-Hold-Schicht.
Diese ist hinter `BUDGET_HARD_HOLDS` (`hardHoldsEnabled()`) gegated und **in der
Produktion eingeschaltet**:

- `server/index.ts:890-906` warnt beim Prod-Start **laut**, wenn das Flag fehlt,
  und loggt „Budget-Hard-Block aktiv in Produktion", wenn es gesetzt ist.
- Regressions-Wächter `tests/architecture/budget-hard-holds-production-enabled.test.ts`
  schlägt fehl, wenn weder der Prod- noch der Shared-Scope das Flag truthy setzt.
- Sichtbar zur Laufzeit unter `/api/health → budgetHardHolds.enabled`.

Damit ist `budget_ledger` aktuell das **aktive** Capture-Ziel einer in Produktion
scharfgeschalteten Funktion, und `budget_transactions` läuft als Legacy-SSoT
**parallel** dazu (Doppel-Buchung). Ein Löschen der drei Tabellen ist deshalb
**kein Aufräumen**, sondern ein **bewusster Rückbau / eine Stilllegung der
Hard-Hold-Funktion** inkl. Produktions-Verhalten.

## Offene Rückfrage an Alrik (Umsetzung blockiert)

Paket 1.1 in der jetzigen Form („3 Tabellen löschen, GoBD direkt auf
`budget_transactions`") setzt eine Vorentscheidung voraus, die nicht im
Aufräum-Scope liegt:

1. **Soll die Hard-Hold-Funktion (BUDGET_HARD_HOLDS) in Produktion
   zurückgebaut werden?** Nur dann werden `budget_reservations` + `budget_ledger`
   überhaupt entbehrlich. Reihenfolge wäre dann: Flag in Prod aus → Engine +
   `unified-reader`-Holds-Read + Capture entfernen → Conservation-/Invarianten-
   Checks auf `budget_transactions` umstellen → erst danach Tabellen droppen.
2. **`budget_migrations`** ist davon unabhängig produktive Infrastruktur
   (Migrations-Guard) und sollte unabhängig vom Hard-Hold-Thema **bestehen
   bleiben**, außer der Migrations-Runner selbst wird ersetzt.

Bis zu dieser Entscheidung bleibt die nachgelagerte Umsetzungs-Aufgabe
(Tabellen entfernen, Wächter umbauen, Schema-Allowlist um genau diese 3 Tabellen
schrumpfen) **blockiert**.
