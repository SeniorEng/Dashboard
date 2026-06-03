# GoBD-Verfahrensdokumentation — Budget-Ledger

> **Status:** PHASE-6-FINALISIERT (`[R11]`). Dieses Dokument beschreibt zwei Ebenen:
> das **Soll-Modell** (North Star: reservierungs-/finanzgetrennter Ledger) als verbindliche
> Ziel-Architektur **und** den **Ist-Zustand nach Phase 6** (Abschnitt direkt unten), der
> dokumentiert, welcher Teil davon heute produktiv ist und welcher bewusst auf eine spätere
> Phase verschoben wurde. Die Soll-Beschreibung bleibt erhalten, weil sie der durable
> Engineering-North-Star ist; sie ist NICHT zu lesen als „so läuft es heute".
>
> **Quellen:** Ziel-Architektur [Budget Greenfield Architecture](./budget-greenfield-architecture.md);
> Entscheidungen [ADR-0001](./adr/0001-reservation-financial-split.md) …
> [ADR-0004](./adr/0004-two-table-non-negativity-guard.md); heutige Historisierungs-Gotchas
> und Phase-6-Endzustand [budget.md](./budget.md); SSoT-Inventur & Phasen-Log
> [budget-ssot-inventory.md](../budget-ssot-inventory.md).

## Ist-Zustand nach Phase 6 (was heute produktiv ist)

Phase 6 hat die **SSoT-Konsolidierung** abgeschlossen, nicht den physischen
Tabellen-Umbau des North Star. Konkret gilt heute:

- **Eine Lese-Quelle für `Available`:** Die unified Verfügbarkeits-Berechnung
  (`readUnifiedBudgetAvailability` / `getAvailableForDate`) ist die **einzige** SSoT für
  „wie viel Budget ist an Datum X frei". Alle Serving-Pfade (Overview, Kostenschätzung,
  Termin-Anlage **und** Termin-Serien-Verlängerung) lesen ausschließlich darüber. Die alten
  Summary-Reader (`getBudgetSummary*`, `getAllBudgetSummaries`) sind aus dem Serving-Pfad
  entfernt und dienen nur noch als **Shadow-/Equality-Baseline** in den Drift-Tests.
- **Legacy-Tabelle `customer_budgets` abgeschaltet (Read & Write):** Kein produktiver
  Lese-Fallback mehr (seit Task #728). Schreibpfad ist No-Op-Stub. Single-Source-of-Truth
  für Topf-Konfiguration ist `customer_budget_type_settings` (append-only historisiert).
  Eine Architektur-Schranke (`tests/architecture/no-customer-budgets-reads.test.ts`) blockt
  neue Leser; die physische Tabelle wird in einer späteren Phase gedroppt.
- **Buchung & Historisierung:** Budget-Verbrauch läuft über `budget_transactions`
  (`consumption` / `reversal`, append-only), Gutschriften über `budget_allocations`
  (no-resurrect), Topf-Konfiguration über `customer_budget_type_settings` (append-only).
  Alle vier sind per BEFORE-Trigger DB-seitig unveränderbar (siehe
  [budget.md → GoBD-Historisierung](./budget.md)). Die Storno-Semantik (`reversal` behält
  `appointmentId`, Summe je Termin = 0) ist umgesetzt.
- **Route→Storage-Folds:** In den Budget-Routen verbleibt keine direkte `db.*`-Choreographie
  mehr; Transaktions-/Schreiblogik liegt im Storage-Layer.
- **Rechnungs-Split pro Topf:** Multi-Pot-Läufe erzeugen N Rechnungen, verbunden über
  `invoices.billing_run_id`; die Σ-Invariante ist per Equality-Test abgesichert.

### Bewusst verschoben (NICHT in Phase 6)

- **Physischer Reservierungs-/Finanz-Ledger-Split** (eigene Tabellen
  `budget_reservations` + `budget_ledger`, ADR-0001..0004): Das Soll-Modell unten beschreibt
  diesen Endzustand; gebaut ist er noch nicht. Heute trägt `budget_transactions` die
  finanzielle Buchung; ein getrennter operativer Hold-Layer existiert (noch) nicht als eigene
  Tabelle.
- **§45b-Materialisierung (Phase 2):** Der §45b-Monatsbetrag wird weiterhin **virtuell**
  (Auto-Renewal-Modell, `calculateAllocated45b`) abgeleitet, nicht als monatliche
  `budget_allocations`-Zeile materialisiert. Daraus resultiert die **eine bekannte und
  akzeptierte** Shadow-Read-Divergenz (siehe nächster Absatz).
- **Drop der `customer_budgets`-Tabelle** (DDL): bleibt für eine spätere Phase, um
  destruktive Drizzle-Push-Diffs zu vermeiden.

### Akzeptierte §45b-Divergenz (Legacy-Summary vs. unified Reader)

Auf §45a und §39/§42a rechnen die Legacy-Summary-Reader und der unified Reader
durchgängig identisch (**Δ0**). Für **§45b** (`entlastungsbetrag_45b`)
besteht eine erwartete Differenz, weil der Legacy-Reader all-time rechnet, während der unified
Reader as-of + `manual_adjustment`-aware rechnet. Diese Divergenz ist **kein Drift-Fehler**,
sondern die designgewollte Folge des virtuellen §45b-Modells; der unified Reader ist die SSoT.
Sie verschwindet erst mit der §45b-Materialisierung (Phase 2) und wird **nicht** durch
Angleichen der Legacy-Mathematik „repariert" (das würde die History-vs-Overview- und
Unified-vs-Legacy-Equality-Netze gegeneinander brechen).

## Zweck dieses Dokuments

Die GoBD (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern,
Aufzeichnungen und Unterlagen in elektronischer Form) verlangen eine
**Verfahrensdokumentation**, anhand derer ein sachverständiger Dritter (z.B. Betriebsprüfer)
das Verfahren nachvollziehen kann. Dieses Dokument beschreibt für die Budget-/Leistungs­abrechnungs-Domäne:

1. den **Datenfluss** von der Terminplanung bis zur abgerechneten Leistung,
2. die **Trennung von Reservierung und Buchung** (operativ vs. steuerlich relevant),
3. die **Unveränderbarkeit** (Immutabilität) der finanziellen Buchungen,
4. die **Korrektur-/Storno-Semantik** (Änderungen nicht unbemerkt),
5. die **Aufbewahrung** (Retention).

Rechtlicher Bezugsrahmen: GoBD i.d.F. der BMF-Schreiben (11.03.2024 / 14.07.2025).

## Kernprinzip

> **Jeder Euro, der existiert oder gebunden ist, ist eine echte Datenbank-Zeile.
> Salden werden ausschließlich per `SUM` über unveränderliche Zeilen abgeleitet —
> niemals als veränderbare Saldo-Spalte gespeichert.**

Eine gecachte Saldo-Spalte ist die klassische Drift-Quelle und ist ausdrücklich verboten.

## Datenfluss (Soll)

```
Termin planen   →  budget_reservations: ∅ → hold        (operativ, NICHT GoBD)
Termin absagen  →  budget_reservations: hold → released (operativ, audit-logged)
Termin fällt    →  budget_reservations: hold → expired  (operativ, Orphan-Sweep)
Termin leisten  →  budget_reservations: hold → captured
                   + budget_ledger:     ∅ → consumed    (GoBD, eine ACID-Transaktion)
Korrektur       →  budget_ledger:       consumed → reversed
                   + budget_ledger:     ∅ → consumed    (Storno + Neuanlage, append-only)
```

Die Verfügbarkeit jedes Topfes ist die eine Lese-Formel (Single Source of Truth):

```
Available(Topf, Periode) = Allocated − HoldsActive(Reservierungen) − ConsumedNet(Ledger)
```

## Trennung Reservierung ↔ Buchung (ADR-0001)

- **`budget_reservations`** sind **operative Reservierungen** (Holds) auf geplante Termine.
  Sie sind **keine *Buchung*** im steuerlichen Sinn, **nicht** GoBD-relevant und erscheinen
  **nicht** in finanziellen Exporten. Zustände (`hold → captured | released | expired`)
  dürfen verändert werden — jede Transition wird jedoch revisionssicher protokolliert
  (Wer / Wann / Von→Nach).
- **`budget_ledger`** enthält ausschließlich die **finanziell relevanten** Zeilen
  (`consumed`, `reversed`). Nur diese Tabelle unterliegt der GoBD-Immutabilität,
  Storno-Semantik und Aufbewahrung.
- **`budget_allocations`** dokumentieren das vorhandene Guthaben (Gutschriften), inkl. des
  monatlich materialisierten §45b-Betrags.

**Rekonstruierbarkeit (ADR-0002):** Die zeitpunktgenaue Wiederherstellung („as-of")
finanzieller Positionen ist auf den **Finanz-Ledger** beschränkt — er ist die bitemporale
Quelle der Wahrheit. Der Reservierungs-Layer führt ein **append-only Transitions-Audit-Log**,
ausreichend für die Prüfung strittiger Buchungen (Wann wurde geplant, wann
captured/released, durch wen), garantiert aber keine numerische as-of-Wiedergabe der
historischen Verfügbarkeit.

## Unveränderbarkeit (Immutabilität)

- Der Finanz-Ledger ist **append-only**: eine Korrektur ist eine neue `reversed`-Zeile plus
  eine frische `consumed`-Zeile — **niemals** eine In-Place-Änderung. Damit sind Änderungen
  nicht unbemerkt (GoBD).
- Die Immutabilität wird **technisch per raising BEFORE-Trigger** in der Datenbank
  erzwungen (analog zu `audit_log` und den heutigen Budget-Tabellen, siehe
  [budget.md → DB-seitige Unveränderbarkeit per Trigger](./budget.md)). Eine verbotene
  direkte Mutation schlägt mit Fehler fehl, statt still durchzugehen.
- Legitime Ausnahmen (Test-Daten-Purge, Kunden-Merge, Migrationen) setzen transaktions-lokal
  ein GUC-Flag und passieren die Trigger nur für genau diese Transaktion; in Produktion wird
  das Flag nie gesetzt.
- Die **Reservierungs-Tabelle ist von der GoBD-Immutabilität ausgenommen** (operativ), führt
  aber das oben genannte Transitions-Audit-Log.

## Korrektur-/Storno-Semantik

- **Reservierung:** `hold → released` (Absage) bzw. `hold → expired` (Termin verfällt). Ein
  Reschedule über eine Perioden-Grenze = Release im alten + neuer Hold im neuen Zeitraum,
  in **einer** Transaktion (nie null Reservierungen hinterlassen, I19).
- **Finanz-Ledger:** `consumed → reversed` und anschließend eine neue `consumed`-Zeile
  (zusammengesetzte Korrektur). Service-Cent-/Minuten-/Kilometer-Spalten der Reversal-Zeile
  spiegeln die Original-Consumption vorzeichen-invertiert (Summe je Termin = 0, siehe
  [budget.md → Storno / Reversal](./budget.md)).
- **Über-Budget bei Leistung:** Ist die tatsächliche Leistung größer als der Hold und passt
  nicht mehr in die Töpfe, entsteht ein typisiertes Ereignis (`OverBudgetCompletionError`);
  ein geleisteter Termin verschwindet **nie** still aus der Erhaltungsrechnung (I20).

## Capture als eine ACID-Transaktion (ADR-0003)

`hold → captured` schreibt die Reservierungs-Aktualisierung **und** die neue
`consumed`-Ledger-Zeile in **einer** lokalen Datenbank-Transaktion unter **einem**
Idempotenz-Schlüssel. Da beide Tabellen in derselben Datenbank liegen, ist kein
Saga/Outbox-Muster nötig. Halb-captured-Zustände werden vom Conservation-Verifier (I13)
aufgedeckt.

## Überziehungs-Schutz (ADR-0004)

Kein Nebenläufigkeits-Interleaving kann einen **gedeckelten** Topf negativ werden lassen.
Durchgesetzt durch (1) einen per-`(Kunde, Topf, Periode)` Advisory-Lock über die gesamte
Plan-und-Schreib-Transaktion und (2) einen DB-Trigger/Guard, der `Available` aus **beiden**
Tabellen neu ableitet und jede Buchung ablehnt, die einen gedeckelten Topf negativ machen
würde. Ungedeckelte Töpfe (privat/Selbstzahler) sind ausgenommen.

## Aufbewahrung (Retention)

- GoBD-relevante Daten (Finanz-Ledger, Rechnungen, Leistungsnachweise mit Unterschrift,
  Audit-Log) unterliegen der gesetzlichen Aufbewahrungsfrist und werden nicht gelöscht,
  sondern soft-deleted/historisiert.
- Operative Reservierungen sind nicht aufbewahrungspflichtig; ihr Transitions-Audit-Log
  bleibt jedoch erhalten, solange der zugehörige Termin/Ledger-Bezug besteht.
- Detaillierte Fristen und Lösch-/Anonymisierungs-Pfade (DSGVO Art. 17 vs. GoBD-Aufbewahrung)
  werden gemeinsam mit der §45b-Materialisierung (Phase 2) je Tabelle festgeschrieben (siehe
  „Offene Punkte" unten).

## Internes Kontrollsystem (IKS) — laufende Kontrollen

- **Equality-Netz (Drift-Detektoren):** `budget-history-vs-overview.test.ts`,
  `budget-ledger-display-matches-booking.test.ts`,
  `budget-settings-read-modes.test.ts`, `invoice-per-pot-arithmetic.test.ts`.
- **Architektur-Schranken:** `tests/architecture/no-customer-budgets-reads.test.ts`
  (kein neuer `customer_budgets`-Leser), `calculations-in-shared.test.ts` (Berechnungen
  liegen in `shared/domain`), `budget-sentinel-uniqueness.test.ts`.
- **DB-seitige Unveränderbarkeit:** BEFORE-Trigger auf `budget_transactions`/-`allocations`/
  `customer_budget_type_settings`/`invoices` (Startup-verifiziert), Bypass nur per GUC-Flag
  in Wartungs-Transaktionen.

## Offene Punkte (Folgephasen, nicht Phase 6)

- **Physischer Reservierungs-/Finanz-Ledger-Split** (Soll-Modell): konkrete Tabellen-/
  Spalten-Namen und Trigger-Definitionen, sobald das Schema (ADR-0001..0004) gebaut ist.
- **§45b-Materialisierung (Phase 2):** ersetzt das virtuelle Auto-Renewal-Modell durch
  monatliche `budget_allocations`-Zeilen und schließt damit die akzeptierte Shadow-Divergenz.
- **Drop der `customer_budgets`-Tabelle** (DDL) nach der Materialisierungsphase.
- Mapping der gesetzlichen Aufbewahrungsfristen auf die einzelnen Tabellen (DSGVO Art. 17 vs.
  GoBD-Aufbewahrung).
