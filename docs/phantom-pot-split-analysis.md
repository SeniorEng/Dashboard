# Phantom-Topf-Splits in der Rechnungserzeugung — Analyse & Bestandsvermessung

**Status:** Analyse abgeschlossen (read-only). Keine Code- oder Datenänderungen im Rahmen dieser Untersuchung.
**Datenbasis:** Produktions-Replica (read-only, `executeSql({ environment: "production" })`), Stand 06.06.2026.
**Referenzfall:** Egon Uhlig, Kunde 117, Termin 228, §45a, April 2026.

---

## 1. Zusammenfassung (TL;DR)

- Der Bug: Vor dem Fix summierte `getBudgetSplitForAppointments` pro Topf **nur** die
  `transactionType='consumption'`-Zeilen und zog die zugehörigen `reversal`-Zeilen
  **nicht** ab. Ein netto-null belegter Topf (Buchung + sofortiger Storno) erhielt
  dadurch trotzdem einen Pot-Anteil und erzeugte in einem Multi-Topf-Lauf eine eigene,
  **gegenstandslose („Phantom-") Folgerechnung**.
- Der Fix ist **bereits im Code** (`server/services/invoice-data.ts`, siehe §2). Live-Konsum =
  `consumption` **minus** alle Zeilen, auf die ein `reversal.reversedTransactionId` zeigt;
  netto-null-Termine werden read-only aus der aktuellen Allocation re-derived.
- **Im echten Bestand existiert genau EINE Phantom-Rechnung:** `RE-2026-0023`
  (Kunde 117, §45a, **11,81 €**). Sie wurde **nie versendet** (`sent_at = NULL`) und ist
  inzwischen **storniert**. Es gab **keinen** weiteren Multi-Topf-Lauf in Produktion.
- **Echte Multi-Topf-Splits** (legitim) sind davon klar abgrenzbar: aktuell 9 Termine bei
  2 Kunden (77, 95) mit echtem Live-Konsum in zwei Töpfen — diese wurden bislang **nie**
  abgerechnet (keine Rechnungen für 77/95).
- Finanzielle Außenwirkung: **keine** — die Phantom-Rechnung verließ das System nie.
  Aufräum-Restaufwand siehe §6.

---

## 2. Mechanik (mit Code-Belegen)

### 2.1 Wo der Split entsteht

| Schritt | Datei | Funktion |
|---|---|---|
| Pot-Anteile pro Termin ermitteln | `server/services/invoice-data.ts` | `getBudgetSplitForAppointments` |
| Cent-genaue Verteilung der Summen | `shared/domain/budget-invoice-split.ts` | Largest-Remainder |
| Split → N Rechnungen | `server/services/invoice-calc.ts` | `needsBudgetSplit` (potItems.size > 1) → eine Rechnung pro Topf, gemeinsame `billingRunId` |
| Auslöser | `server/routes/billing.ts` | `/preview`, `/generate` |

Ein Lauf, der Anteile aus mehreren Töpfen ermittelt, erzeugt **N Rechnungen** (eine pro
`budget_type` + optional Selbstzahler-Rest), verbunden über `invoices.billing_run_id`
(Variant C, Task #759). Single-Topf-Läufe lassen `billing_run_id`/`budget_type` NULL.

### 2.2 Der fehlerhafte Pfad (vor dem Fix)

`getBudgetSplitForAppointments` las pro Termin die `consumption`-Zeilen und addierte
`Math.abs(amountCents)` je Topf. **Reversal-Zeilen wurden ignoriert.** Folge: Ein Topf,
dessen einzige Buchung am selben Tag wieder storniert wurde (netto null), erschien mit
einem positiven Gewicht in der Verteilung → eigene Rechnung im Multi-Topf-Lauf.

### 2.3 Der Fix (Task #1011, bereits im Code)

`server/services/invoice-data.ts:367-437` — Live-Konsum schließt stornierte Buchungen aus:

```ts
// Stornierte Original-Buchungen ermitteln: jede consumption-Zeile, deren ID
// von einer reversal-Zeile referenziert wird, ist netto null und zählt nicht.
const reversedIds = new Set<number>(/* reversal.reversedTransactionId → consumption.id */);
...
for (const txn of txns) {
  ...
  if (reversedIds.has(txn.id)) continue; // stornierte Buchung → kein Pot-Anteil
  entry.cents[potKey] += Math.abs(txn.amountCents);
}
```

Termine, deren Buchungen **alle** storniert wurden (netto null, aber Service wurde
erbracht und ist abrechenbar), fallen **nicht** blind auf `private`, sondern werden über
`rederiveSplitFromCurrentAllocation` (`:448-505`) read-only gegen die aktuelle
Topf-Verfügbarkeit (`readUnifiedBudgetAvailability` → `planCascade`,
Priorität §45b → §45a → §39/§42a, Rest → private) neu verteilt. Es wird **nichts**
gebucht — Preview und Generate sehen denselben Split.

---

## 3. Referenzfall: Kunde 117 (Egon Uhlig), Termin 228, §45a, April 2026

### 3.1 Budget-Transaktionen für Termin 228

| tx id | budget_type | datum | typ | betrag | reversed_tx | erstellt |
|---|---|---|---|---:|---|---|
| 424 | umwandlung_45a | 2026-04-02 | consumption | −2380 | — | 2026-04-02 |
| 425 | umwandlung_45a | 2026-04-02 | reversal | +2380 | **424** | 2026-04-02 |
| 1149 | entlastungsbetrag_45b | 2026-04-02 | consumption | −2345 | — | 2026-05-29 |
| 2071 | entlastungsbetrag_45b | 2026-04-02 | reversal | +2345 | **1149** | 2026-06-06 19:23 |

→ **§45a war seit 02.04.2026 netto null** (Buchung 424 noch am selben Tag durch 425
storniert). §45b (1149) war zum Generierungszeitpunkt (06.06. 11:35) **live**; dessen
Storno (2071) kam erst abends um 19:23 — also **nach** der Rechnungserzeugung.

### 3.2 Was der (alte) Split daraus machte

Der Lauf am **06.06.2026 11:35:58** (`billing_run_id = 21365147-38dd-4b6a-a6a8-0a65f2e4746b`)
erzeugte zwei Rechnungen:

| Rechnung | id | Topf | Termine (line items) | Brutto |
|---|---|---|---|---:|
| RE-2026-0022 | 23 | entlastungsbetrag_45b | 228 (1042+122=1164), 229 (4750+777=5527) | **6691** |
| RE-2026-0023 | 24 | umwandlung_45a | 228 (1058+123) | **1181** ← Phantom |

Die Termin-228-Kost (2345 = aktiver §45b-Konsum) wurde im alten Code nach den
**Konsum-Gewichten** §45a:§45b = 2380:2345 verteilt:
`§45a = round(2345 × 2380/4725) = 1181`, `§45b = 2345 − 1181 = 1164`.
Korrekt wäre gewesen: **kompletter Betrag (2345) → §45b**, da §45a netto null. Die
herausgelösten **11,81 €** sind die Phantom-Rechnung.

### 3.3 Status der Phantom-Rechnung

`RE-2026-0023` (id 24): `status = storniert`, **`sent_at = NULL`** (nie versendet),
`storniert_at = 2026-06-06 19:23:38`. Stornorechnung `RE-2026-0024` (−1181) existiert als
`entwurf`. Die Begleit-Rechnung `RE-2026-0022` (§45b, war zur Generierung echt) wurde
ebenfalls storniert (`RE-2026-0025`, −6691, `entwurf`), nie versendet.

---

## 4. Bestandsvermessung (Produktion, read-only)

### 4.1 Census aller Rechnungen

| Kennzahl | Wert |
|---|---:|
| Rechnungen gesamt | 25 |
| mit `billing_run_id` (Multi-Topf-Lauf) | 2 |
| mit `budget_type` (Pot-typisiert) | 2 |
| verschiedene `billing_run_id` | **1** |
| Kunden mit Split-/Pot-Rechnungen | **1** (Kunde 117) |

→ Es gibt **genau einen** Multi-Topf-Lauf im gesamten Produktionsbestand, und der gehört
zum Referenzfall.

### 4.2 Phantom-Rechnungen im Bestand

**Genau 1:** `RE-2026-0023` (Kunde 117, §45a, 11,81 €). Belegt durch: der einzige von der
Rechnung abgedeckte Termin (228) hat in `umwandlung_45a` **netto-null** Konsum — die
einzige Buchung (424) wurde am selben Tag storniert (425), zwei Monate **vor** der
Rechnungserzeugung. Damit ist der Fall **zeitpunkt-unabhängig** eindeutig Phantom (anders
als die §45b-Schwester, die nur durch spätere Stornos rückwirkend netto null wurde —
siehe §5).

### 4.3 Phantom vs. echter Multi-Topf-Split

Aktueller Live-Konsum pro (Termin × Topf) im Gesamtbestand:

| Kategorie | Anzahl |
|---|---:|
| Termine mit Budget-Transaktionen | 550 |
| **Echte** Multi-Topf-Termine (≥2 Töpfe mit Live-Konsum) | **9** |
| Voll stornierte Termine (Konsum vorhanden, netto null) | 36 |

Die 9 echten Multi-Topf-Termine (legitime Split-Kandidaten):

| Kunde | Termine | Live-Töpfe |
|---|---|---|
| 77 | 270, 271, 272 | entlastungsbetrag_45b **+** ersatzpflege_39_42a |
| 95 | 154, 182, 255, 269, 302, 515 | entlastungsbetrag_45b **+** ersatzpflege_39_42a |

Diese Termine haben echten, **nicht** stornierten Konsum in zwei Kassen-Töpfen
(Cascading-Allocation §45b → §39/§42a). Kunden 77 und 95 haben **keine** Rechnungen —
diese legitimen Splits wurden **nie** abgerechnet. Sie würden korrekt je 2 Rechnungen
erzeugen und sind **kein** Phantom.

**Abgrenzungskriterium:** Phantom = Pot-typisierte Rechnung, deren abgedeckte Termine in
diesem `budget_type` **netto-null** Konsum haben. Echter Split = ≥2 Töpfe mit aktivem
(nicht storniertem) Konsum.

---

## 5. Wichtige Einschränkung: Phantom-Erkennung ist zeitpunktabhängig

Eine naive „aktueller Zustand"-Abfrage (Termine mit netto-null-Topf **und** Live-Topf
gleichzeitig) liefert in Produktion **0 Treffer** — obwohl Termin 228 der Lehrbuch-Fall
ist. Grund: Der §45b-Konsum von Termin 228 wurde am selben Abend (19:23) ebenfalls
storniert und der gesamte Lauf storniert. Im **heutigen** Zustand sind beide Töpfe von
Termin 228 netto null (er liegt in den „36 voll stornierten Termine").

Der Phantom-Split entstand zum **Generierungszeitpunkt** (06.06. 11:35), als §45b live und
§45a bereits storniert war. Für die Vermessung **ausgegebener** Rechnungen ist deshalb die
`invoices`-Tabelle die belastbare Quelle (§4.1/4.2), nicht der aktuelle
Transaktions-Snapshot. Der zeitpunkt-robuste Detektor lautet: *pot-typisierte Rechnung,
deren Termine im jeweiligen `budget_type` netto-null Konsum aufweisen* — was `RE-2026-0023`
eindeutig erfüllt.

---

## 6. Status der Phantom-Rechnungen: ausgegeben/versendet vs. nur Preview

- **Ausgegeben & versendet:** keine. Die einzige Phantom-Rechnung (`RE-2026-0023`) wurde
  als `entwurf` erzeugt, **nie versendet** (`sent_at = NULL`) und ist nun `storniert`.
- **Nur in Vorschauen:** Previews werden **nicht** als Rechnungen persistiert und sind
  daher aus dem Datenbestand nicht zählbar. Da der Fix (§2.3) aktiv ist, erzeugen aktuelle
  Previews/Generate-Läufe keine Phantom-Splits mehr.
- **Offener Aufräum-Rest (Kunde 117, April 2026):** Vier Stornorechnungen liegen als
  `entwurf` vor (`RE-2026-0005`, `RE-2026-0016`, `RE-2026-0024`, `RE-2026-0025`). Netto sind
  die erbrachten April-Leistungen (Termine 228/229) derzeit **unberechnet**, weil der ganze
  Lauf storniert wurde. Eine **korrekte Neu-Abrechnung** (jetzt mit Fix: §45b-only für
  Termin 228) steht noch aus.

---

## 7. Empfehlungen (priorisiert)

1. **[P1] Deployment des Fixes verifizieren.** Die Phantom-Rechnung wurde am 06.06.2026
   11:35 erzeugt — zu diesem Zeitpunkt war der fehlerhafte Pfad in Produktion live. Vor der
   Neu-Abrechnung von Kunde 117 sicherstellen, dass der Task-#1011-Fix in der
   produktiven Version aktiv ist (sonst reproduziert sich der Phantom-Split).
2. **[P1] Kunde 117 / April 2026 sauber neu abrechnen.** Vier offene Storno-Entwürfe
   finalisieren und eine korrekte Rechnung für die erbrachten Leistungen (Termine 228/229,
   §45b) erzeugen, damit die April-Leistungen nicht dauerhaft unberechnet bleiben.
   (Fachliche Freigabe/Manuell — kein Bestandteil dieser Analyse.)
3. **[P2] Regressionstest auf Split-Ebene.** Test, der sicherstellt, dass
   `getBudgetSplitForAppointments` für einen netto-null belegten Topf **keinen** Pot-Anteil
   liefert (Buchung + Storno → 0 Anteile), inkl. des Re-Derivation-Pfads
   (`rederiveSplitFromCurrentAllocation`). Andockpunkt: bestehende Equality-/Drift-Detektoren
   unter `tests/equality/`.
4. **[P2] Monitoring-Query / Reconciliation.** Periodische read-only-Prüfung, die jede
   pot-typisierte Rechnung flaggt, deren abgedeckte Termine im jeweiligen `budget_type`
   netto-null Konsum haben — fängt künftige Phantom-Splits unabhängig vom Code-Pfad ab.
5. **[P3] Split-Begründung am Lauf persistieren.** Da Phantom-Erkennung zeitpunktabhängig
   ist (§5), bei der Generierung die Pot-Gewichte + live/storniert-Flags pro Termin
   mitschreiben (z.B. in `render_snapshot`/Notes), damit ein Lauf später eindeutig als
   Phantom oder echt auditierbar bleibt.

---

## 8. Methodik & Reproduzierbarkeit

Alle Messungen read-only gegen die Produktions-Replica
(`executeSql({ environment: "production" })`). Kernabfragen:

- **Census:** `SELECT count(*) FILTER (WHERE billing_run_id IS NOT NULL) ...` auf `invoices`.
- **Pot/Termin-Netto:** pro `(customer_id, appointment_id, budget_type)` die Summe
  `amount_cents` über `transaction_type IN ('consumption','reversal')`; `< 0` = Live-Topf,
  `= 0` bei vorhandener Konsumption = netto-null-Topf.
- **Echte Multi-Topf-Termine:** Termine mit `COUNT(*) FILTER (net < 0) >= 2`.
- **Phantom-Beleg:** Line-Items von `RE-2026-0023` (alle Termin 228) gegen netto-null-§45a
  von Termin 228 gehalten.

Der Dev-Datenbestand enthält den realen Bestand **nicht** (frisch geseedet, 16 Rechnungen,
0 Splits) — die Vermessung ist nur gegen Produktion aussagekräftig.
