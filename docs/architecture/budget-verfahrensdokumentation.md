# GoBD-Verfahrensdokumentation — Budget-Ledger (Seed)

> **Status:** SEED (Phase 0, Task #870). Dies ist die initiale Fassung der
> GoBD-Verfahrensdokumentation für die Budget-Domäne. Sie wird in **Phase 6**
> (`[R11]`) finalisiert, sobald der reservierungs-/finanzgetrennte Ledger produktiv
> ist und die Legacy-Pfade abgeschaltet sind. Bis dahin beschreibt sie das **Soll-Modell**
> (North Star), nicht den heutigen Ist-Zustand.
>
> **Quellen:** Ziel-Architektur [Budget Greenfield Architecture](./budget-greenfield-architecture.md);
> Entscheidungen [ADR-0001](./adr/0001-reservation-financial-split.md) …
> [ADR-0004](./adr/0004-two-table-non-negativity-guard.md); heutige Historisierungs-Gotchas
> [budget.md](./budget.md).

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
  werden in der **Phase-6-Finalisierung** ergänzt.

## Offene Punkte für die Phase-6-Finalisierung

- Konkrete Tabellen-/Spalten-Namen und Trigger-Definitionen, sobald das Schema gebaut ist
  (Phase 1+).
- Mapping der gesetzlichen Aufbewahrungsfristen auf die einzelnen Tabellen.
- Beschreibung des Internen Kontrollsystems (IKS): Conservation-Verifier (I13),
  Shadow-Read-Soak (I18), Orphan-Sweep (R6) als laufende Kontrollen.
- Verweise auf die konkreten Test-Artefakte (Equality-Netz, Property-Tests, Stress-Tests)
  als Nachweis der Verfahrenssicherheit.
