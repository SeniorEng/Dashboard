---
name: Budget Cap-SSoT (computeCapSlot)
description: Single source of truth für Pflegegrad-/Jahres-Klemmen in §45a + §39_42a — sowohl Buchung als auch Overview-Anzeige müssen über computeCapSlot rechnen, sonst driftet Anzeige vom Buchungs-Cap.
---

# Cap-Berechnung für §45a und §39_42a: computeCapSlot ist die SSoT

`server/storage/budget/cap-calculator.ts → computeCapSlot()` ist die einzige
zugelassene Stelle für die "wieviel kann ich noch buchen"-Mathematik der
beiden Cap-Pots (§45a Monats-Cap, §39_42a Jahres-Cap). Wer eine eigene
Window-Net-Mathe rechnet ("currentAvailable = allocated − used") driftet
SOFORT vom Buchungspfad, sobald `monthlyLimit`/`yearlyLimit` in
`customer_budget_type_settings` über dem gesetzlichen Pflegegrad-/Jahres-Cap
liegt — die Buchung klemmt, die Anzeige nicht.

## Warum
- `BUDGET_45A_MAX_BY_PFLEGEGRAD` (PG-abhängig) und
  `BUDGET_39_42A_MAX_YEARLY_CENTS` (Jahresfix) sind statutorische Obergrenzen,
  nicht konfigurierbar.
- `clampToStatutoryMax`/`computeCapSlot` klemmen `monthlyLimit`/`yearlyLimit`
  silently bevor sie als Cap angesetzt werden. Verunreinigte Settings-Daten
  (manueller SQL, alter Backfill, fehlerhafte Migration) bringen den Inline-
  Pfad zum Drift; den computeCapSlot-Pfad nicht.
- §45b ist EXPLIZIT KEIN Cap-Pot (Jahrestopf). `computeCapSlot` liefert für
  §45b `Infinity` — Available wird dort weiter per Allocation minus Booked
  berechnet.

## Wann anwenden
- Jede neue Anzeige- oder Aggregations-Funktion, die "wieviel kann der Kunde
  diesen Monat/dieses Jahr noch via §45a/§39_42a buchen" beantworten soll,
  MUSS `computeCapSlot()` rufen und `capRemainingCents` ausgeben.
- `currentMonthAllocatedCents`/`currentYearAllocatedCents` bleiben weiter aus
  `calculateAllocatedCents` (Auto-Renewal-aware) — die beiden Werte ergänzen
  sich: Allocated = "wieviel ist budgetiert", Cap-Remaining = "wieviel davon
  ist nach statutorischer Klemme und bereits verbuchten Beträgen tatsächlich
  noch buchbar".
- Edge-Case bleibt: typeSetting INACTIVE (validFrom > today oder validTo <
  today) → currentAvailableCents = 0 (vor computeCapSlot prüfen).

## Drift-Detektoren
- `tests/equality/45a-overview-statutory-clamp.test.ts` — PG2 + monthlyLimit
  > statutorischer Max → Overview darf den Cap nicht überschreiten.
- `tests/equality/39-42a-overview-statutory-clamp.test.ts` — yearlyLimit >
  statutorischer Jahres-Cap → analog.
