# P1-Exposure-Runbook — Belegnummern-Wiedervergabe & Storno-Umgehung

**Zweck.** Feststellen, ob der P1-Befund aus dem Gate-2-Review zu #61 auf Prod
jemals eingetreten ist. Reine Diagnose, keine Korrektur.

**Status des Befunds.** Offen, Entscheidung bei Alrik. Der Code liegt seit
Task #1434 (`a05b1ce3`) in `main`; dieses Runbook ändert nichts daran.

---

## Der Befund in einem Absatz

Eine versendete Rechnung lässt sich über „Auf Entwurf zurücksetzen" in den
Entwurfs-Status zurückholen. Dabei wird `sent_at` geleert
(`server/storage/billing-storage.ts:143`). Danach greift der Lösch-Guard nicht
mehr: `bulk-delete` und `discard-drafts` löschen **hart**
(`tx.delete(invoicesTable)`), geguardet ausschließlich über `status = 'entwurf'`
und `invoice_type <> 'stornorechnung'` — **ohne** `sent_at`- oder
Zustell-Prüfung (`server/routes/billing.ts:826-833`). Die Positionen kaskadieren
mit (`shared/schema/billing.ts:152`). Da die nächste Nummer als
`MAX(...) + 1` über die **vorhandenen** Zeilen bestimmt wird
(`server/storage/billing-storage.ts:157-171`), wird die Nummer der gelöschten
Rechnung anschließend **neu vergeben**.

Ergebnis im Extremfall: dieselbe Belegnummer bezeichnet zwei verschiedene
Dokumente, ohne Storno, und der neue Beleg kann zum heutigen Preis höher
ausfallen. Beides steht ausdrücklich gegen CLAUDE.md → „GoBD".

**Abschwächend:** `audit_log` hat keinen Fremdschlüssel auf `invoices`. Die
Einträge `invoice_sent` und `invoice_draft_discarded` (inkl. `invoiceNumber` und
`grossAmountCents`) überleben die Löschung — der Vorgang bleibt rekonstruierbar.
Das ersetzt weder den Storno noch verhindert es die Wiedervergabe.

---

## Warum die Abfrage über das Audit-Log geht

`invoices` trägt eine `UNIQUE` auf `invoice_number`
(`shared/schema/billing.ts:114`). Eine wiedervergebene Nummer ist in `invoices`
allein daher **prinzipiell unsichtbar** — die alte Zeile existiert nicht mehr.
Das Audit-Log ist der einzige Nachweis.

**Block B liest bewusst zwei Schlüssel** — `COALESCE(previousStatus, oldStatus)`.
Der Einzelpfad (`server/routes/billing.ts:1687`) schreibt `oldStatus`, der
Sammelpfad (`:903`) `previousStatus`. Eine Auswertung über nur einen der beiden
verliert die Hälfte der Vorgänge und meldet womöglich fälschlich „keine Treffer".

---

## Ausführung

- **Ausschließlich lesend.** Nur `SELECT`/`WITH`, kein `INSERT`/`UPDATE`/
  `DELETE`, keine DDL, keine Funktion mit Seiteneffekt. Auf Prod gefahrlos.
- Syntaktisch gegen das echte Schema geprüft; **nicht** auf Prod ausgeführt.
- Empfehlung: `\timing on` und `SET statement_timeout = '60s';`.
- Genutzte Indizes: `audit_log_action_idx`, `audit_log_entity_idx`,
  `audit_log_metadata_idx` (GIN), `invoices_invoice_number_key`.
- **Block D immer mitlaufen lassen** (siehe Auswertung).

Die Abfragen liegen als ausführbare Datei daneben:
[`p1-invoice-number-reuse-exposure.sql`](./p1-invoice-number-reuse-exposure.sql).

---

## Auswertung — was ein Treffer bedeutet

| Block | Frage | Bedeutung eines Treffers |
|---|---|---|
| **A** | Wurde je eine Belegnummer wiedervergeben? | Der GoBD-scharfe Fall: dieselbe Nummer bezeichnet zwei Dokumente. `differenz_cents > 0` = der neue Beleg ist teurer als der gelöschte, also ein rückwirkend erhöhter Betrag ohne Storno. |
| **B** | Wurde eine versendete Rechnung auf Entwurf zurückgesetzt? | Vorstufe der Kette, für sich noch kein Schaden — Task #1434 wollte den Fall „zu früh als versendet markiert" korrigierbar machen. `rechnung_existiert_noch = false` heißt: danach hart gelöscht. |
| **C** | Volle Kette versendet → zurückgesetzt → gelöscht | Verletzt Storno-Pflicht **und** Nummernkreis zugleich. `nummer_wiedervergeben = true` verknüpft den Vorgang mit A. |
| **D** | Kontext-Zähler | Größenordnung — und `audit_log_beginnt_am` sagt, ab wann die Antwort überhaupt trägt. |

### Der wichtigste Vorbehalt

**Ein leeres Ergebnis in A–C ist nur dann ein Freispruch, wenn
`audit_log_beginnt_am` vor der Einführung von Task #1434 liegt.** Andernfalls
lautet die Aussage ausschließlich: „im abgedeckten Zeitraum nichts gefunden".

### Wenn A oder C Treffer liefern

Das ist eine Risiko-/Rechtsfrage, keine Testfrage — Gate 4 (Alrik). Die Zeilen
enthalten alles für die Rekonstruktion: Belegnummer, beide Rechnungs-IDs,
Zeitpunkte, handelnder Benutzer, beide Beträge und die Differenz.

---

## Mögliche Schließungen des Befunds (nicht Teil dieses Runbooks)

Beide Wege sind Vorschläge zur Entscheidung, keine Empfehlung:

1. **Reset einschränken:** „Auf Entwurf zurücksetzen" nur erlauben, solange kein
   `invoice_sent`-Audit existiert — also nur der „zu früh markiert"-Fall, den
   Task #1434 im Titel meint.
2. **Löschung sperren:** Hart-Löschung verbieten, sobald die Rechnung je ein
   `sent_at` getragen hat.

---

## Herkunft

Gefunden im Gate-2-Review zu PR #61, Kette anschließend Glied für Glied
verifiziert. Dokumentiert als `FINDING [P1]` in den PR-Bodys von #61 und #62.
