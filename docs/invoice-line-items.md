# Rechnungs-Line-Item-Mengen

Detail-Runbook zur Mengen-/Quantisierungs-Logik von Rechnungs-Line-Items.
Übergeordneter Projekt-README: [`../replit.md`](../replit.md). Budget-/Rechnungs-Split-Architektur
siehe [`architecture/budget.md`](architecture/budget.md).

## Kilometer-Quantisierung (Task #561)

Kilometer-Lines (`serviceCode IN ('travel_km','customer_km')`) MÜSSEN über `shared/domain/invoice-line-items.ts` quantisiert werden — `quantizeKm` rundet die GPS-/Routing-Strecke auf 2 NK, und genau dieser Wert geht via `computeKmLineTotalCents(km, rate)` in `totalCents` **und** via `formatKmQuantityDisplay`/`renderLineItemQuantity` ins PDF. Niemals `km * rate` ungerundet rechnen und parallel `Math.round(km)` anzeigen — das war der Drift-Bug aus RE-2026-0003 (Menge × Satz ≠ Summe).

Persistierte Spalten: `invoice_line_items.quantity_raw` (real, Dezimal-km oder Dezimalstunden) + `quantity_unit` (`hours`/`km`); historische Zeilen vor #561 haben beide auf NULL, PDF-Template und ZUGFeRD-Mapper fallen dann auf `durationMinutes` zurück (GoBD-Immutabilität — Bestandsrechnungen werden nicht überschrieben, Korrektur via Storno + Neuanlage, siehe [`deployment-log.md`](deployment-log.md)).

Drift-Detektor: `tests/equality/invoice-line-item-arithmetic.test.ts` (fast-check), Audit: `scripts/audit-invoice-line-items.ts`.
