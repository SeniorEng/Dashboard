# Katrin Mentke (Kunde 182) — §45b-Monats-Cap blockierte den eigenen Topf

- **Datum der Korrektur:** 13.05.2026
- **Task:** #423
- **Skript (gelöscht nach Anwendung):** `server/scripts/fix-customer-182-budget-cap.ts`,
  eingeführt in `aadfe236` (13.05.2026)

## Problem

Bei Kundin 182 standen zwei Werte gegeneinander:

- `customer_budget_type_settings.entlastungsbetrag_45b.monthly_limit_cents = 13100` (131 €)
- `budget_allocations.initial_balance.amountCents = 39300` (393 €) für Mai 2026

Der 393-€-Startwert war als aggregierter Drei-Monats-Topf eingetragen (3 × 131 €).
Zusammen mit dem zusätzlichen Monats-Cap von 131 € entstand ein Widerspruch: im
Mai waren bereits über 121 € verbraucht, der Cap verhinderte weitere Buchungen —
obwohl der Topf noch rund 271 € auswies. Folge: verwirrende Anzeige und ein
**Hard-Block beim Dokumentieren** neuer Termine.

## Maßnahme

`monthly_limit_cents` auf `NULL` gesetzt. Der 393-€-Startwert bleibt die SSoT
für das verfügbare Guthaben. Der Lauf war idempotent, Trockenlauf als Default,
mit Audit-Eintrag.

## Vorher / Nachher

| | Vorher | Nachher |
|---|---|---|
| `monthly_limit_cents` (§45b, Kunde 182) | `13100` | `NULL` |
| verfügbares Guthaben Mai 2026 | ~271 € vorhanden, aber durch Cap blockiert | frei buchbar |

## Warum das Skript ersatzlos entfällt

Zwei unabhängige Gründe:

1. **Der Mechanismus existiert nicht mehr.** Der §45b-Fenster-Cap
   (Task #1171/BUG-21) ist strukturell abgeschafft: `shared/domain/budget/cap-math.ts`
   liefert für §45b **immer** `POSITIVE_INFINITY`, und §45b ist nicht mehr in
   `isCappedBudget` (`server/storage/budget/consumption-engine.ts`). Ein
   Per-Kunde-Datenfix gegen einen Cap, den es nicht gibt, ist gegenstandslos —
   so steht es auch in `docs/architecture/budget.md`, Abschnitt „Entscheidung
   (Alrik-Direktive)".
2. **Der gesetzte `NULL`-Wert ist unter der heutigen Semantik folgenlos.** Die
   Spalte bedeutet inzwischen nicht mehr „Buchungs-Cap", sondern
   „monatliche Aufstockungsrate". Ein `NULL` fällt dort auf
   `DEFAULT_MONTHLY_BUDGET_CENTS` zurück
   (`server/storage/budget/allocation-storage.ts`, `monthlyAmountFor`) — die
   Kundin verliert also keine Rate.

Beim Ablegen geprüft: Punkt 2 war der einzige denkbare Spätschaden dieser
Korrektur, und er tritt nicht ein.

## Audit-Referenz

git-Historie (`aadfe236`) · DB-Audit-Log zum 13.05.2026 auf
`customer_budget_type_settings` für Kunde 182 · dieses Protokoll.
