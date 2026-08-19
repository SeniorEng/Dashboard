# Rechnungsstatus — autoritative Modell-Karte

**Read-only, Stand 17.08.2026 gegen `main` (nach #106). Kein Code geändert.**
Schritt 1 zum Aufräum-Task. Zweck: erst wissen, was es gibt, bevor irgendwer
etwas zusammenlegt.

> **Bestandsaufnahme, nicht Zielbild.** Was daraus werden soll, steht in
> [`rechnungsstatus-zielmodell.md`](./rechnungsstatus-zielmodell.md). Dieses
> Dokument beschreibt den Zustand VOR dem Umbau und bleibt als Beleg stehen —
> die Widersprüche W1–W5 sind die Begründung für das Ziel-Modell.

---

## Die vier Ebenen

| Ebene | Werte | Fundstelle | Art |
|---|---|---|---|
| **1 — `invoices.status`** | `entwurf` · `versendet` · `avis_erhalten` · `teilweise_bezahlt` · `bezahlt` · `storniert` | `shared/schema/billing.ts:14` (`INVOICE_STATUSES`), Spalte `:72`, Default `entwurf` | **persistiert** |
| **2 — `invoices.invoice_type`** | `rechnung` · `stornorechnung` · **`nachberechnung`** | `shared/schema/billing.ts:32` (`INVOICE_TYPES`), Spalte `:46` | **persistiert** |
| **3a — Pipeline-STUFE** | (Termin: `offen` · `dokumentiert` · `unterschrieben`) → `rechnung_erstellt` · `versendet` · `avis_erhalten` · `bezahlt` | `shared/domain/billing-pipeline.ts:34` (`PIPELINE_STAGES`), Zuordnung `:258` (`assignInvoiceStage`) | abgeleitet |
| **3b — Handlungs-CLUSTER** | `zu_versenden` · `avis_ausstehend` · `zahlung_ausstehend` · `zahlung_zugeordnet_pruefung` · `teilzahlung` · `abgeschlossen` · `storniert` | `shared/domain/billing-pipeline.ts:298` (`INVOICE_ACTION_CLUSTERS`), Zuordnung `:367` (`assignInvoiceActionCluster`) | abgeleitet |
| **4 — Payment-Status** | `bezahlt` · `teilweise_bezahlt` · `null` | `shared/domain/qonto/invoice-payment-status.ts:51` (`resolveInvoicePaymentStatus`) | abgeleitet, **schreibt aber auf Ebene 1** |

**Korrektur zur Aufgabenstellung:** Ebene 2 heißt nicht `normal`, sondern
`rechnung` — und hat einen **dritten** Wert. `nachberechnung` ist als Typ seit
Task #585 abgeschafft, lebt aber in historischen Zeilen weiter (Spalte ist
`text`, keine Enum-Migration, GoBD-Immutabilität) und wird für Anzeige und PDF
auf „Rechnung" gemappt. Wer Ebene 2 als Zweiwertigkeit modelliert, verliert
Altbestand.

**Ebene 3 sind zwei Ebenen, nicht eine.** Stufe (€-Summen des Cockpit-Boards)
und Cluster (Handlungs-Sicht der Rechnungsliste) sind verschiedene Enums mit
verschiedenen Konsumenten. Sie hängen zusammen, sind aber nicht ineinander
überführbar — siehe Widerspruch W1.

---

## Ableitungsregeln, explizit

### Ebene 1+2 → Stufe (`assignInvoiceStage`)

```
isStorniertInvoice(status='storniert' ODER invoiceType='stornorechnung')
                                        → side: "storniert"   (zählt in KEINE Stufe)
status = entwurf                        → stage: rechnung_erstellt
status = versendet                      → stage: versendet
status = avis_erhalten                  → stage: avis_erhalten
status = bezahlt                        → stage: bezahlt
sonst (default)                         → stage: rechnung_erstellt
```

`teilweise_bezahlt` hat **keinen eigenen Zweig** und fällt in `default`.

### Stufe + Zahler-Typ + Zahlungsbindung → Cluster (`assignInvoiceActionCluster`)

```
kind != "stage"                         → storniert
status = teilweise_bezahlt              → teilzahlung        ← Vorgriff VOR der Stufe
hasBoundPayment && stage ∈ {versendet, avis_erhalten}
                                        → zahlung_zugeordnet_pruefung
stage = rechnung_erstellt               → zu_versenden
stage = versendet   & Selbstzahler/Privat → zahlung_ausstehend
stage = versendet   & Pflegekasse       → avis_ausstehend
stage = avis_erhalten                   → zahlung_ausstehend
stage = bezahlt                         → abgeschlossen
```

### Zahlungsstand → Ebene 1 (`resolveInvoicePaymentStatus`)

```
paidCents <= 0                          → null   (Status bleibt unverändert)
voll gedeckt (exact | tolerated)        → "bezahlt"
Unterzahlung, paidCents > 0             → "teilweise_bezahlt"
Überzahlung über Toleranz (overpaid)    → null   (flaggen, NIE still "bezahlt")
```

### Manuelle Übergänge (`INVOICE_STATUS_TRANSITIONS`, `shared/domain/invoice-status.ts:36`)

```
entwurf           → versendet, storniert
versendet         → avis_erhalten, bezahlt, storniert
avis_erhalten     → bezahlt, storniert
teilweise_bezahlt → bezahlt, storniert          (nur als AUSGANG)
bezahlt           → storniert
storniert         → —
```

---

## Wo es überlappt und widerspricht

### W1 — `teilweise_bezahlt` lebt auf Ebene 1 **und** 4, und die Stufe kennt es nicht

Der Status ist auf Ebene 1 persistiert, entsteht aber ausschließlich auf
Ebene 4. `assignInvoiceStage` wurde bei seiner Einführung (#1822) **nicht**
erweitert — eine teilbezahlte Rechnung landet über `default` auf
`rechnung_erstellt`.

Der Cluster-Pfad fängt das mit einem Vorgriff ab und sagt im Kommentar selbst,
was er nicht repariert:

> *„Die STUFEN-Zuordnung bleibt davon unberührt (eigene Frage, eigener
> Blast-Radius: sie trägt die €-Summen des Cockpit-Boards)."*

**Folge, ungeprüft aber am Code ablesbar:** im Cockpit-Board zählt der Betrag
einer teilbezahlten Rechnung in der Stufe **„Rechnung erstellt"** — neben den
Entwürfen. Die Liste zeigt sie korrekt unter „Teilzahlung", das Board also
nicht. Das ist kein Anzeige-Detail, sondern eine Geld-Summe an der falschen
Stelle.

**Gemessen (Referenz-Kopie, Stand 13.08.): `teilweise_bezahlt` = 0 Zeilen.**
Der Fehler ist also heute latent, nicht wirksam — und genau deshalb ist er
gefährlich: er schlägt beim ERSTEN Teilzahlungs-Fall zu, und dann als falsche
€-Summe im Board, nicht als Fehlermeldung.

### W2 — Ebene 4 ist als „Ableitung" deklariert, schreibt aber Ebene 1

`resolveInvoicePaymentStatus` ist rein und DB-frei — die Aufrufer
(`server/services/qonto.ts:533`, `server/routes/admin/qonto.ts:288`) setzen das
Ergebnis aber direkt in die Spalte. Damit ist `teilweise_bezahlt` gleichzeitig
abgeleiteter Wert **und** persistierter Zustand. Zwei Wahrheiten über dieselbe
Frage, die nur solange gleich sind, wie niemand die Spalte anders anfasst.

### W3 — Zwei Schreib-Regime auf Ebene 1, nur eines davon geht über die Übergangs-SSoT

- **Manuell**: `PATCH /billing/:id/status` und `POST /billing/bulk-status`
  gehen über `isAllowedInvoiceStatusTransition`.
- **Zahlungsabgleich**: setzt per **Direkt-Update** mit eigenem `WHERE`-Guard
  (`server/routes/admin/qonto.ts:701`, `:1361`, `server/services/qonto.ts`).
  Die Übergangs-Map gilt dort **nicht**.

Der Docstring benennt das ausdrücklich. Es ist bewusst, aber es heißt: die
Übergangs-SSoT beschreibt nur die Hälfte der Wirklichkeit. Wer sie liest und
für vollständig hält, irrt.

### W4 — `storniert` ist zweimal ausdrückbar

`status='storniert'` **oder** `invoiceType='stornorechnung'`. `isStorniertInvoice`
ist die SSoT dafür und wird geteilt — gut. Aber die Zweiwertigkeit selbst bleibt:
eine Gutschrift ist „storniert", ohne dass ihr Status es sagt.

### W5 — Der `default`-Zweig verschluckt Unbekanntes still

Beide Zuordnungen fangen unbekannte Status konservativ ab (`rechnung_erstellt`
bzw. `zu_versenden`), ausdrücklich damit „kein € still verlorengeht". Der Preis:
ein neuer Status ist an keiner Stelle laut. Genau so ist `teilweise_bezahlt`
zwei Ebenen tief unbemerkt falsch eingeordnet worden.

---

## (a) Unterscheidet sich das Verhalten je Empfänger?

**Ja, an genau einer Stelle im Modell — und die ist begründet.**

`agingModelForBillingType` (`billing-pipeline.ts:444`):
`selbstzahler`/`privat` → `selbstzahler`, alles andere → `pflegekasse_pre_avis`.

Wirkt zweifach:

1. **Cluster**: `versendet` → Selbstzahler `zahlung_ausstehend`, Pflegekasse
   `avis_ausstehend`.
2. **Aging-Anker**: Selbstzahler altert am **Fälligkeitsdatum** (`dueDate`),
   Pflegekasse vor Avis-Eingang am **Versanddatum** (`sentAt`).

**Sachlich richtig:** bei der Kasse liegt zwischen Versand und Zahlung ein
eigener Schritt (Avis), beim Kunden nicht. Das ist keine willkürliche
Sonderbehandlung, sondern zwei verschiedene reale Abläufe.

**Aber — die Ebene 1 kennt diesen Unterschied nicht.** `avis_erhalten` ist für
alle Rechnungen setzbar:

- Der manuelle Endpoint erlaubt `z.enum(["versendet","avis_erhalten","bezahlt"])`
  **ohne Zahler-Typ-Prüfung** (`server/routes/billing.ts:1078`).
- Ein Selbstzahler kann damit auf `avis_erhalten` gesetzt werden, obwohl es dort
  kein Avis gibt.
- Der Cluster verschluckt es geräuschlos: `avis_erhalten` → `zahlung_ausstehend`,
  also derselbe Cluster wie `versendet` beim Selbstzahler. Es fällt niemandem auf.

**Für Alriks Ziel „alle Rechnungen gleich" ist das die zentrale Stelle.** Der
Unterschied sitzt nicht im Status-Modell, sondern in der Ableitung. Man kann die
Status vereinheitlichen, ohne den Ablauf zu vereinheitlichen — oder man erklärt
den Avis-Schritt zum Normalfall für alle. Das ist eine fachliche Entscheidung,
keine technische.

---

## (b) Woher kommen die Zwischenstatus, wer setzt sie?

### `avis_erhalten` — drei Schreiber

| Wer | Fundstelle | Guard |
|---|---|---|
| Avis-Abgleich (Treffer) | `server/routes/admin/qonto.ts:1361` | nur `WHERE status='versendet'`, audit-protokolliert |
| Zahlungs-Rücknahme | `server/routes/admin/qonto.ts:701` | `bezahlt` → `avis_erhalten`, setzt `paidAt=null` |
| Einmal-Backfill | `server/startup/backfill-avis-received-status.ts:80` | Task #1284, historische Zeilen |
| Mensch (manuell) | `PATCH /:id/status`, `POST /bulk-status` | über die Übergangs-SSoT, **ohne** Zahler-Typ-Prüfung |

### `teilweise_bezahlt` — genau ein Regime

Ausschließlich der Zahlungsabgleich über `resolveInvoicePaymentStatus`
(`server/services/qonto.ts:533`, `server/routes/admin/qonto.ts:288`).
**Manuell nicht setzbar** — in der Übergangs-Map nur als Ausgang. Das ist
sauber und ausdrücklich so gebaut.

### `zahlung_zugeordnet_pruefung` — gar kein Status

**Reiner Cluster, nie persistiert.** Entsteht aus `hasBoundPayment === true` in
Verbindung mit Stufe `versendet`/`avis_erhalten`. Die Bindung kommt
ausschließlich aus `qontoStorage.getClaimedInvoiceIds` (1:1-Match oder
Avis-Mitgliedschaft) und wird vom Listen-Endpunkt mitgeliefert; fehlt sie,
verhält sich die Zuordnung wie vorher (`undefined` = `false`).

Bedeutung: *das Geld ist da, es fehlt nur die Entscheidung.*

### `teilzahlung` — Cluster über Status

Reiner Cluster, aber 1:1 aus dem persistierten `teilweise_bezahlt` abgeleitet
(der Vorgriff aus W1).

---

## Bestand (Referenz-Kopie, Stand 13.08.)

| status | invoice_type | Anzahl | Brutto |
|---|---|---|---|
| `versendet` | rechnung | 172 | 23.748,53 € |
| `storniert` | rechnung | 110 | 15.460,37 € |
| `entwurf` | **stornorechnung** | **114** | −15.884,35 € |
| `bezahlt` | rechnung | 73 | 8.822,69 € |
| `avis_erhalten` | rechnung | 54 | 7.785,20 € |
| `entwurf` | rechnung | 10 | 569,33 € |
| `storniert` | **nachberechnung** | **4** | 423,98 € |
| `teilweise_bezahlt` | — | **0** | — |

Drei Beobachtungen, die für den Aufräum-Schritt zählen:

- **`teilweise_bezahlt` = 0.** W1 ist latent. Kein Grund zur Eile — aber auch
  keiner zur Entwarnung: der erste Teilzahlungs-Fall trifft direkt eine
  €-Summe.
- **`nachberechnung` existiert wirklich** (4 Zeilen). Ebene 2 als
  Zweiwertigkeit zu modellieren würde sie treffen.
- **114 Gutschriften stehen auf `entwurf`** — mehr als jeder andere
  Status/Typ-Paarung außer `versendet`. Sie sind über `isStorniertInvoice`
  (Typ, nicht Status) als „storniert" eingeordnet, ihr Status bleibt aber für
  immer `entwurf`. Ob eine Gutschrift je „versendet" wird, ist eine offene
  fachliche Frage — im Modell ist sie jedenfalls nicht vorgesehen. Das ist W4
  in Zahlen.

## Was ich NICHT geprüft habe

- **Die Konsumenten der Stufen-Summen** (Cockpit-Board, Statistik) habe ich
  nicht durchgezählt — W1 ist am Code hergeleitet, nicht an der Anzeige
  nachgestellt.
- **`paidAt` / `sentAt` / Zahlungs-Tabellen** als eigene Wahrheitsquellen neben
  dem Status. Sie tauchen hier nur auf, wo sie mitgeschrieben werden.
- **Termin-Stufen** (`offen`/`dokumentiert`/`unterschrieben`) — sie teilen sich
  das `PIPELINE_STAGES`-Enum mit den Rechnungs-Stufen, gehören aber zu einer
  anderen Frage.
