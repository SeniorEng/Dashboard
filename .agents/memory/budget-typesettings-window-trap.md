---
name: customer_budget_type_settings — Window-Shifts auf einzelner picked-row
description: Bei mehreren append-only-Zeilen pro (customer, budgetType) darf ein allocStart/end-Shift NICHT die einzelne aus typeSettings gepickte Zeile als Quelle verwenden — sonst fallen Monate vor dem Wechsel raus.
---

**Regel:** Für jede Allocation-Window-Berechnung über `customer_budget_type_settings` muss die Fenster-Grenze aus der **vollständigen Liste aller §X-Zeilen** des Kunden abgeleitet werden (FRÜHESTES `validFrom`, SPÄTESTES `validTo` — oder `null` falls eine Zeile offen ist), nicht aus einer einzelnen via `typeSettings.find(...)` gepickten Zeile.

**Why:** Append-only-Transitionen schließen die alte Zeile (`validTo = X`) und legen eine neue Zeile mit `validFrom = X+1` an. `typeSettings.find(s => s.budgetType === ... && s.enabled)` liefert typischerweise die LATEST aktive Zeile zurück. Deren `validFrom` ist dann der Transitions-Termin und schiebt `allocStart` fälschlich nach vorn — alle Monate vor dem Wechsel fallen aus der Iteration. Repro: alte §45b-Zeile Jan 1→Mai 27 geschlossen, neue Zeile ab Mai 28 → Jan–Apr verschwanden, Jahressumme war nur der Mai-Anteil statt 4×Default + Mai-Anteil.

**How to apply:** Bei jeder neuen §X-Allocation/Cap-Funktion: die Zeilen aus DB als sortierte Liste laden (asc by validFrom), dann `earliest = list[0].validFrom` und `latest = any(r.validTo == null) ? null : max(r.validTo)`. Fallback auf gepickte typeSetting nur wenn die Liste leer ist. Gilt analog für §45a und §39/§42a — wenn dort später transition-aware Fenster gebraucht werden.
