---
name: Budget-Ledger dual-link (Stufe A)
description: budget_reservations now carries BOTH captured_ledger_id AND captured_transaction_id; how the second link is derived and why budget_ledger still exists.
---

# Budget-Ledger Dual-Link (Ablösung von `budget_ledger`, Stufe A)

`budget_ledger` ist ein reiner Spiegel von `budget_transactions` (Capture-Insert im Hard-Hold-Pfad). Sein einziger produktiver Zweck war der Link `budget_reservations.captured_ledger_id`. Der mehrstufige Plan (Ticket #1253) löst die Tabelle ab: Stufe A führt einen ZWEITEN direkten Link auf die gespiegelte `budget_transactions`-Zeile ein, Stufe B stellt Conservation/Invarianten von `budget_ledger` auf `budget_transactions` um, Stufe C baut die Tabelle (und `captured_ledger_id`) zurück.

## Wie der zweite Link OHNE Raten entsteht
Beim Capture wird pro Topf die `id` DERSELBEN Konsum-Zeile, aus der die Ledger-Zeile gespiegelt wurde, als `captured_transaction_id` gesetzt (Mirror der `ledgerByType`-Semantik: erste Konsum-Zeile eines Topfes gewinnt). Der Bestand wird über den `captureKey`/`idempotencyKey` der Ledger-Zeile gemappt: Format `capture:a{appt}:o{occ}:{budgetType}:l{legacyTxId}`, wobei `legacyTxId` exakt die `budget_transactions.id` ist (`:l(\d+)$` parsen, gegen Kunde+Topf verifizieren).

**Why:** Der Link muss deterministisch eindeutig sein — der `legacyTxId` im idempotencyKey ist die einzige verlässliche Quelle für den Bestand; heuristisches Raten ist verboten (Gate A→B: nicht mappbare Zeilen werden NUR berichtet, von Alrik triagiert).

## Conservation-Divergenz-Zähler
`ConservationResult.linkDivergences` (Teilmenge von `crossViolations`, Details in `crossDetails`): captured Reservierungen mit BEIDEN Links müssen auf denselben fachlichen Datensatz (Termin + Topf + Betrag) zeigen. Reservierungen mit `captured_transaction_id IS NULL` (Bestand vor Backfill) sind KEINE Divergenz. Gesunde DB ⇒ 0. Divergenz > 0 ⇒ STOPPEN + Report.

**How to apply:** Wer eine neue `ConservationResult`-Konstruktion baut (z.B. Test-Helper `conservation()`), MUSS `linkDivergences` mitführen, sonst bricht `tsc`. In Stufe B wandert die Conservation-Leserseite auf `budget_transactions`; den Spiegel-INSERT NICHT vorher entfernen.

## Was NICHT angefasst werden darf (bis Stufe B/C)
- KEIN Entfernen des Spiegel-INSERTs in `budget_ledger`.
- KEINE Immutability-Trigger auf `budget_transactions`, kein Umzug von `ensure-budget-ledger-immutability`.
- KEIN `DROP TABLE budget_ledger`, kein Entfernen von `captured_ledger_id`.
- Hard-Block (`BUDGET_HARD_HOLDS`) liest über `readUnifiedBudgetAvailability` aus `budget_transactions` + `budget_reservations`, hängt NICHT an `budget_ledger` — muss scharf bleiben.
