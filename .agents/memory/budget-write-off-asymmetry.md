---
name: Budget write_off-Asymmetrie (Fenster-Cap vs. Topf-Sicht)
description: Wann zählt budget_transactions.transactionType='write_off' als Used und wann nicht — die Asymmetrie ist intentional und modelliert zwei Sichten, nicht ein Versehen.
---

**Regel:** `write_off` zählt in der **Topf-/Allocation-Sicht** als Used (Geld ist aus dem Topf raus), aber NICHT in der **Fenster-Cap-Sicht** (es ist keine Termin-Konsumption im Fenster).

**Why:** Ein Carryover-Verfall am 30.06. (z.B. §45b) darf im Folgemonat den Buchungs-Cap für neue Termine nicht reduzieren — sonst würde der Verfall eines Vorjahres-Restguthabens das aktuelle Monatsbudget künstlich blockieren. Aber er muss in `availableCents` der Topf-Anzeige sichtbar sein, sonst stimmt der Topf-Rest nach dem Verfall nicht.

**How to apply:** Bei jeder neuen Aggregation über `budget_transactions` die Frage stellen „berechne ich Fenster-Cap (Buchbarkeit eines neuen Termins) oder Topf-Rest (was ist insgesamt aus dem Topf raus)?"
- Fenster-Cap → `transactionType IN ('consumption', 'reversal')` ohne `write_off`
- Topf-/Allocation-Sicht → `transactionType IN ('consumption', 'write_off', 'reversal')`

Vollständige Call-Site-Inventur und Begründung pro Stelle: `docs/budget-ssot-inventory.md` Abschnitt „write_off-Asymmetrie-Audit". Phase 1.3 hebt die Regel als Architecture-Test fest.
