# Preis-SSoT (`priceFor`) — Phase 3.3

Eine einzige Auflösung beantwortet die fachliche Frage **„Welcher Preis gilt für
Kunde X, Service Y am Datum Z?"**. Anzeige- und Schreibpfade importieren dieselbe
Funktion — keine parallelen Preis-Berechnungen mehr.

## Bestandteile

| Ebene | Datei | Aufgabe |
|---|---|---|
| Reine Auflösung | `shared/domain/pricing/price-for.ts` (`resolvePriceFor`) | Pure, I/O-freie Reihenfolge Kunden-Override → Standard → Katalog-Default; zeitversioniert. |
| Server-Lader | `server/storage/pricing/price-for.ts` (`loadCustomerPriceContext`) | Lädt aktive Kundenzeilen (repo-vermittelt, Soft-Delete-konform) + Katalog und stellt `resolveByCode`/`resolveById` bereit. |

### Auflösungsreihenfolge

1. **Kunden-Preis** (`customer_service_prices`) — die **Existenz** einer
   Kundenzeile gewinnt IMMER über Standard/Default, auch bei `priceCents = 0`
   (= explizit kostenlos, z. B. „keine Anfahrt"). Es zählt nie der Wert, sondern
   die vorhandene Zeile. **Kein `||`/`value > 0`-Kurzschluss** darf 0 auf Standard
   umkippen — durchgängig `??`/Row-present.
2. **Standard-Preis** — firmenweit, zeitversioniert. **Schatten-Hook, heute leer**,
   bis die konsolidierte `prices`-Tabelle den Standard-Scope befüllt (siehe unten).
3. **Katalog-Default** — `services.defaultPriceCents`; nicht abrechenbare Services
   (`isBillable === false`) lösen 0 auf.

## Verdrahtete Live-Konsumenten

Alle laufenden Preis-Lookups gehen durch die SSoT — keine eigenen
`customer_service_prices`-Reads mehr:

- `server/storage/budget/appointment-cost-calculator.ts` (`calculateAppointmentCost`)
- `server/services/invoice-data.ts` (Rechnungs-/LN-Line-Items)
- `server/routes/budget.ts` (Budget-Vorschau)

## Schattenmodus (aktueller Stand)

Der Standard-Scope ist absichtlich leer. Damit fällt die Auflösung wertneutral
vom Kunden-Preis direkt auf den Katalog-Default — **exakt das heutige Verhalten**.
Die Verdrahtung ist also value-neutral; es ändert sich kein berechneter Preis.

### Read-only-Diagnose-Skripte (vor dem Cutover)

| Skript | Zweck |
|---|---|
| `server/scripts/report-price-consolidation-conflicts.ts` | Liest alle drei Quellen (`customer_service_prices`, `customer_contract_rates`, `service_rates`), erstellt die verlustfreie Migrations-Vorschau, listet 0-/Gratis-Zeilen explizit auf und meldet Konflikte (beide Kundenquellen aktiv mit abweichendem Betrag) sowie unzuordenbare Zeilen. Optionaler `--csv=`. |
| `server/scripts/shadow-diff-price-for.ts` | Vergleicht `priceFor` (SSoT) gegen einen **unabhängigen** Referenz-Resolver über reale Termin-Tupel der letzten N Monate (`--months=`, Default 12). Bricht mit Exit 2 ab, wenn der Datensatz keinen echten 0-Override-Kunden enthält (Constraint #1). |

Beide Skripte sind strikt lesend (kein `--apply`) und schreiben nichts.

## Regressionstests (schattenmodus-unabhängig)

- `tests/unit/pricing-price-for.test.ts` — die reine Auflösung inkl. 0-Override-
  Gewinn und Gegenprobe.
- `tests/pricing-price-for-cost.test.ts` — der verdrahtete Termin-Kostenpfad:
  Kunden-Override = 0 ⇒ `priceFor` liefert 0 (nicht Default); Gegenprobe
  ohne Override ⇒ Katalog-Default.

## GoBD-Verifikation

- **Bereits fakturierte Snapshots werden NICHT neu berechnet.** Versiegelte
  Rechnungen rendern aus ihrem `render_snapshot` (eingefrorene Beträge, Profil,
  `lineAggregation`, Erstelldatum) — der `priceFor`-Pfad greift ausschließlich
  bei der **Neu-Erzeugung** (`generateInvoiceCore`/Termin-Buchung), nicht beim
  Re-Render bestehender Rechnungen. Damit bleiben Integritäts-Hash und
  EN-16931-Konformität bestehender Belege unberührt.
- Soft-Delete-Disziplin bleibt erhalten: der Server-Lader liest über das Repo
  (`customerServicePricesRepo.activeOnly()`), nie roh über gelöschte Zeilen.
- Die Diagnose-Skripte sind read-only; sie verändern keine Buchungen/Belege.

## Noch offen — menschlich freigegeben (Step 4, NICHT Teil dieser Phase)

Erst **nach Alriks Freigabe** auf Basis der Diagnose-Reports:

1. Konsolidierung der drei Tabellen in eine `prices`-Tabelle (Standard-Scope
   befüllen) — verlustfreie Migration BEIDER Kundenquellen inkl. 0-/Gratis-Zeilen.
2. Löschen der Alt-Tabellen.
3. Aktivierung eines Architektur-Guards (analog `tests/architecture/ssot-imports.test.ts`),
   der eigene `customer_service_prices`/`service_rates`-Reads außerhalb der SSoT
   verbietet.
