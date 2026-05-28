---
name: Invoice-per-pot split (Variant C)
description: How multi-pot billing runs split into N invoices linked by billing_run_id, and the invariants that protect Σ.
---

Wenn ein Abrechnungslauf Anteile aus mehreren Budget-Töpfen verbraucht hat,
entstehen N getrennte Rechnungen — eine pro `budget_type` (+ optional eine
Selbstzahler-Rechnung). Verbunden über `invoices.billing_run_id` (uuid).
Single-Pot-Läufe behalten das Bestand-Single-Invoice-Verhalten und beide
neuen Spalten bleiben NULL (kein Bestand-Rewrite, GoBD-konform).

**Pflicht-Invariante:** Σ aller Pot-Rechnungen + Selbstzahler-Pot =
Σ Termin-Beträge des Laufs. Realisiert via Largest-Remainder mit
deterministischem Tiebreak (`POT_ORDER`) in
`shared/domain/budget-invoice-split.ts`. **Why:** Variant B (eine Rechnung
mit gemischtem Empfänger) hatte Kostenträger-Trennungs- und Storno-
Probleme; Variant C trennt die Verantwortungen pro Pot, riskiert dafür
aber Cent-Drift, wenn man die Verteilung nicht als pure Funktion mit
Resttropfen-Logik schreibt. **How to apply:** Jede neue Aggregation, die
über `budget_transactions` oder Line-Items läuft und Pot-Anteile zurück-
rechnet, muss diese pure Funktion verwenden — niemals `Math.round`/
`Math.floor` pro Pot einzeln. Drift-Detektor:
`tests/equality/invoice-per-pot-arithmetic.test.ts` (fast-check).

**Cascade-Storno:** `PATCH /api/billing/:id/status` mit
`cascadeRun: true` storniert alle Geschwister einer `billing_run_id`-
Gruppe in derselben `withAudit`-Transaktion (pro Geschwister eigene
Storno-Nummer + Audit-Eintrag + Hintergrund-PDF). **Why:** Ohne Cascade
würden Empfänger inkonsistent werden (Kasse storniert, Selbstzahler
bleibt offen), was GoBD verletzt. **How to apply:** Cascade-Flag NIE
automatisch setzen — Trigger muss explizit aus dem UI/Admin-Pfad
kommen; alle anderen Status-Übergänge bleiben pro Rechnung.

**Empfänger-Routing:** `resolveBudgetRecipient(customerId, budgetType,
asOf)` — Override-Tabelle `customer_budget_recipients` (append-only) →
Kasse (für Kassen-Töpfe) → Kunde. `rechnungAnKunde=true` zwingt alles
auf Kunden-Adresse (Kostenerstattungsverfahren).
