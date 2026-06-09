# Rechnungs-Line-Item-Mengen

Detail-Runbook zur Mengen-/Quantisierungs-Logik von Rechnungs-Line-Items.
Übergeordneter Projekt-README: [`../replit.md`](../replit.md). Budget-/Rechnungs-Split-Architektur
siehe [`architecture/budget.md`](architecture/budget.md).

## Kilometer-Quantisierung (Task #561)

Kilometer-Lines (`serviceCode IN ('travel_km','customer_km')`) MÜSSEN über `shared/domain/invoice-line-items.ts` quantisiert werden — `quantizeKm` rundet die GPS-/Routing-Strecke auf 2 NK, und genau dieser Wert geht via `computeKmLineTotalCents(km, rate)` in `totalCents` **und** via `formatKmQuantityDisplay`/`renderLineItemQuantity` ins PDF. Niemals `km * rate` ungerundet rechnen und parallel `Math.round(km)` anzeigen — das war der Drift-Bug aus RE-2026-0003 (Menge × Satz ≠ Summe).

Persistierte Spalten: `invoice_line_items.quantity_raw` (real, Dezimal-km oder Dezimalstunden) + `quantity_unit` (`hours`/`km`); historische Zeilen vor #561 haben beide auf NULL, PDF-Template und ZUGFeRD-Mapper fallen dann auf `durationMinutes` zurück (GoBD-Immutabilität — Bestandsrechnungen werden nicht überschrieben, Korrektur via Storno + Neuanlage, siehe [`deployment-log.md`](deployment-log.md)).

Drift-Detektor: `tests/equality/invoice-line-item-arithmetic.test.ts` (fast-check), Audit: `scripts/audit-invoice-line-items.ts`.

## Kumulierte Positionen (Task #1083)

Das Rechnungs-PDF (und das eingebettete ZUGFeRD/EN-16931-XML) listet die Positionen **kumuliert** statt pro Termin:

- **eine Zeile je Leistungs-Typ** (gleicher `serviceCode` + gleicher Stückpreis + gleiche Einheit),
- **EINE gemeinsame „Fahrtkosten"-Zeile** je Stückpreis (mergt `travel_km` + `customer_km`),
- **`no_show_charge` bleibt pro Termin** stehen (das Datum ist Teil der Leistungsbeschreibung),
- die Spalten **Datum/Uhrzeit entfallen** in der kumulierten Ansicht.

Die Logik ist die reine Funktion `aggregateInvoiceLineItems()` in `shared/domain/invoice-line-aggregation.ts` — sie ist die EINZIGE Quelle, die PDF-Renderer (`server/lib/pdf-generator.ts`) **und** ZUGFeRD-Mapper (`server/lib/zugferd.ts`) teilen, damit beide exakt dieselben kumulierten Positionen sehen. Σ(`totalCents`) bleibt bit-genau erhalten (= `netAmountCents`), sodass die ZUGFeRD-Reconciliation (LineTotalSum == Nettobetrag) und BR-CO-10/13 weiter halten.

**Wichtig — nur Render-/XML-Ebene**: Die persistierten `invoice_line_items` bleiben unverändert pro Termin (führen weiter `appointmentId` für Doppelabrechnungs-Guard und Pot-Split) und sind die Quelle für den **pro-Termin-Leistungsnachweis** (LN, NICHT kumuliert).

**GoBD-Byte-Stabilität**: Der Modus ist pro Rechnung im `renderSnapshot.lineAggregation` eingefroren (`"cumulative"` für neu versiegelte Rechnungen). Re-Renders (Integritäts-Verifier, Self-Heal, Send-Cache-Miss) reproduzieren den versiegelten Modus byte-genau. Bestände, die VOR Task #1083 versiegelt wurden, haben kein `lineAggregation` im Snapshot → default `"per_appointment"` → reproduzieren das alte XML/PDF byte-genau.

Unit-Test: `tests/unit/invoice-line-aggregation.test.ts` (Merge, no_show-Passthrough, Reihenfolge, Σ-Invariante). Der pro-Termin-XML-Roundtrip ist in `tests/equality/zugferd-roundtrip.test.ts` auf `lineAggregation: "per_appointment"` gepinnt.
