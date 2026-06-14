---
name: Budget-Ledger dual-link (Stufe A→C, abgeschlossen)
description: How captured_transaction_id became the ONE capture link; budget_ledger + captured_ledger_id are now removed (Stufe C).
---

# Budget-Ledger Dual-Link → Single-Link (Ablösung von `budget_ledger`, A→C)

`budget_ledger` war ein reiner Spiegel von `budget_transactions` (Capture-Insert im Hard-Hold-Pfad). Sein einziger produktiver Zweck war der Link `budget_reservations.captured_ledger_id`. Der mehrstufige Plan hat die Tabelle abgelöst: Stufe A führte einen ZWEITEN direkten Link auf die gespiegelte `budget_transactions`-Zeile ein, Stufe B stellte Conservation/Invarianten von `budget_ledger` auf `budget_transactions` um, **Stufe C (Task #1274) hat die Tabelle `budget_ledger` UND `captured_ledger_id` entfernt** — `captured_transaction_id` ist seither der EINE Capture-Link.

## Wie der zweite Link OHNE Raten entsteht
Beim Capture wird pro Topf die `id` DERSELBEN Konsum-Zeile, aus der die Ledger-Zeile gespiegelt wurde, als `captured_transaction_id` gesetzt (Mirror der `ledgerByType`-Semantik: erste Konsum-Zeile eines Topfes gewinnt). Der Bestand wird über den `captureKey`/`idempotencyKey` der Ledger-Zeile gemappt: Format `capture:a{appt}:o{occ}:{budgetType}:l{legacyTxId}`, wobei `legacyTxId` exakt die `budget_transactions.id` ist (`:l(\d+)$` parsen, gegen Kunde+Topf verifizieren).

**Why:** Der Link muss deterministisch eindeutig sein — der `legacyTxId` im idempotencyKey ist die einzige verlässliche Quelle für den Bestand; heuristisches Raten ist verboten (Gate A→B: nicht mappbare Zeilen werden NUR berichtet, von Alrik triagiert).

## Conservation-Divergenz-Zähler
`ConservationResult.linkDivergences` (Teilmenge von `crossViolations`, Details in `crossDetails`): captured Reservierungen mit BEIDEN Links müssen auf denselben fachlichen Datensatz (Termin + Topf + Betrag) zeigen. Reservierungen mit `captured_transaction_id IS NULL` (Bestand vor Backfill) sind KEINE Divergenz. Gesunde DB ⇒ 0. Divergenz > 0 ⇒ STOPPEN + Report.

**How to apply:** Wer eine neue `ConservationResult`-Konstruktion baut (z.B. Test-Helper `conservation()`), MUSS `linkDivergences` mitführen, sonst bricht `tsc`. In Stufe B wandert die Conservation-Leserseite auf `budget_transactions`; den Spiegel-INSERT NICHT vorher entfernen.

## Endzustand (nach Stufe C)
- `budget_ledger` + `captured_ledger_id` sind ENTFERNT (`server/startup/drop-budget-ledger.ts`, idempotent rohes SQL, kein `drizzle-kit push`). `captured_transaction_id` ist der EINE Capture-Link.
- GoBD-Immutability liegt auf `budget_transactions` (`ensure-budget-transactions-immutability.ts`); Append-only-Wächter retargetet auf `tests/architecture/budget-transactions-write-path.test.ts`.
- Hard-Block (`BUDGET_HARD_HOLDS`) liest über `readUnifiedBudgetAvailability` aus `budget_transactions` + `budget_reservations`, hing NIE an `budget_ledger` — muss scharf bleiben.
