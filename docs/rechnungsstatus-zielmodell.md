# Rechnungsstatus — Ziel-Modell (Spezifikation)

**Schritt 2 zum Aufräum-Task. Design-Doc, kein Code.** Erst nach Freigabe dieser
Spec wird gebaut.

Grundlage ist die Bestandsaufnahme in [`statusmodell-karte.md`](./statusmodell-karte.md)
— dort steht, was es heute gibt und wo es sich widerspricht. Hier steht, was es
werden soll.

Modell bestätigt von Alrik am 17.08.2026. Diese Spec schreibt es aus, benennt
die Ableitungsregeln und die Migration — und drei Stellen, an denen das Modell
auf die vorhandenen Daten trifft und eine Entscheidung braucht (Abschnitt 7).

---

## 1. Das Modell

### Gespeichert: vier Status

```
entwurf  →  versendet  →  bezahlt
                ↓             ↓
            storniert  ←──────┘
```

| Status | Bedeutung |
|---|---|
| `entwurf` | erstellt, noch nicht ausgegeben. Änderbar, löschbar. |
| `versendet` | ausgegeben. Ab hier gilt GoBD: keine stille Änderung mehr. |
| `bezahlt` | vollständig bezahlt (innerhalb der Zahlungs-Toleranz). |
| `storniert` | **terminal für alles Terminale** — uneinbringlich, abgelehnt, zurückgezogen. Es gibt keinen zweiten Weg aus dem Vorgang heraus. |

`entwurf → storniert` ist zulässig (ein Entwurf kann verworfen werden), führt
aber praktisch selten dorthin — ein Entwurf wird gelöscht, nicht storniert.

### Abgeleitet: zwei Badges, kein Status

| Badge | Regel | Quelle |
|---|---|---|
| **Teilweise bezahlt** | `0 < Σ gezahlt < Brutto` | Zahlungssumme, nicht Statusspalte |
| **Überfällig** | unbezahlt **und** Fälligkeit überschritten | `dueDate` bzw. Zahler-Anker |

Badges sind **Sichten auf Zahlen**, keine Zustände. Sie werden nie geschrieben,
nie migriert, nie als Übergang geprüft. Zwei Rechnungen mit demselben Status
können verschiedene Badges tragen — das ist der Punkt.

### Typ

`rechnung` · `stornorechnung` · (`nachberechnung` — historisch, GoBD, wird
**nicht angefasst**; Anzeige mappt weiterhin auf „Rechnung")

**Der Begriff „Gutschrift" entfällt.** Eine Stornorechnung ist ein
Rechnungsdokument wie jedes andere und durchläuft **dieselben Status**.

### Avis ist keine Status-Stufe

Der Zahlungsavis der Kasse ist eine **Zuordnungs-Mechanik**: er verbindet einen
Geldeingang mit einer Rechnung. Genau wie eine Qonto-Banktransaktion. Beide
Quellen leiten dasselbe ab — `bezahlt` oder das Teilzahlungs-Badge.

`avis_erhalten` verschwindet als Status.

### Der Empfänger-Unterschied verlässt das Modell

Kasse und Selbstzahler haben **dieselben vier Status**. Der Avis ist lediglich
eine andere Zuordnungs-Quelle, kein anderer Lebenszyklus.

Was bleiben **darf**, weil es keine Status-Frage ist: der **Aging-Anker**
(Selbstzahler ab Fälligkeit, Kasse ab Versand). Das ist eine Frage an das
Überfällig-Badge, nicht an den Status. Siehe Abschnitt 7.3.

---

## 2. SSoT-Zuordnung

| Was | Wo | Art |
|---|---|---|
| **Status** | `invoices.status` | **einzige gespeicherte Wahrheit** |
| Pipeline-Stufe | abgeleitet aus Status + Typ | rein abgeleitet |
| Handlungs-Cluster | abgeleitet aus Stufe + Zahlungsbindung | rein abgeleitet |
| Teilzahlung | abgeleitet aus der Zahlungssumme | **Badge**, nie Status |
| Überfälligkeit | abgeleitet aus Zahlungsstand + Frist | **Badge**, nie Status |

Damit lösen sich drei Widersprüche der Bestandsaufnahme auf:

- **W1** (`teilweise_bezahlt` auf zwei Ebenen) — es gibt den Status nicht mehr.
- **W2** (Ableitung schreibt Spalte) — der Zahlungsabgleich schreibt nur noch
  `bezahlt`, und das ist ein echter Zustandswechsel, keine Ableitung.
- **W4** (`storniert` zweimal ausdrückbar) — der Typ sagt nichts mehr über den
  Zustand. Storniert ist, was `status = 'storniert'` hat.

**W5 (stille `default`-Schlucker) wird ausdrücklich aufgehoben:** ein
unbekannter Status muss auffallen. Siehe Abschnitt 4.

---

## 3. Was verschwindet

| Weg | Ersatz |
|---|---|
| Status `avis_erhalten` | Der Avis bleibt als Zuordnungs-Mechanik; der Status wird `versendet` bis zur Zahlung. |
| Status `teilweise_bezahlt` | Badge aus der Zahlungssumme. |
| Cluster `avis_ausstehend` | entfällt mit dem Empfänger-Unterschied — beide warten auf Zahlung. |
| Cluster `teilzahlung` | Badge. |
| Side-Zustand „storniert per **Typ**" | nur noch per Status. |
| Beide `default`-Zweige | harter Fehler statt stiller Einordnung. |

Was **bleibt**: `zahlung_zugeordnet_pruefung`. Er war nie ein Status, sondern
ein Cluster aus der Zahlungsbindung — die Frage „Geld da, Entscheidung offen"
bleibt real und unabhängig vom Status.

---

## 4. Ableitungsregeln

### Status + Typ → Stufe

```
status = storniert   → side: storniert   (zählt in keine Stufe)
status = entwurf     → stage: rechnung_erstellt
status = versendet   → stage: versendet
status = bezahlt     → stage: bezahlt
sonst                → FEHLER
```

**Kein `default`-Schlucker mehr.** Ein unbekannter Status ist ein
Programmierfehler und muss als solcher sichtbar werden — im Server als
geworfener Fehler, im Client als sichtbarer Defekt. Die bisherige „konservative"
Einordnung hat genau den Fehler erzeugt, den dieser Umbau behebt: ein neuer
Status fiel zwei Ebenen tief unbemerkt an die falsche Stelle.

Umsetzungshinweis: mit `INVOICE_STATUSES` als `as const`-Union und einem
erschöpfenden `switch` fängt bereits `tsc` den fehlenden Zweig. Der
Laufzeit-Fehler ist die zweite Lage für Werte, die aus der DB kommen.

### Stufe + Zahlungsbindung → Cluster

```
side: storniert                          → storniert
hasBoundPayment && stage = versendet     → zahlung_zugeordnet_pruefung
stage = rechnung_erstellt                → zu_versenden
stage = versendet                        → zahlung_ausstehend
stage = bezahlt                          → abgeschlossen
```

Der Zahler-Typ kommt hier **nicht mehr vor**. Das ist die konkrete Wirkung von
„Empfänger-Unterschied raus".

### Zahlungen → Status und Badges

```
Σ gezahlt <= 0                    → Status unverändert, kein Badge
0 < Σ gezahlt < Brutto (unter Toleranz)
                                  → Status unverändert (versendet), Badge „Teilweise bezahlt"
voll gedeckt (exact | tolerated)  → Status := bezahlt
Überzahlung über Toleranz         → Status unverändert, zur Prüfung markieren
                                    (Invariante: NIE still auf bezahlt)
```

Die Überzahlungs-Invariante bleibt unverändert — sie ist heute richtig.

### Übergänge

```
entwurf    → versendet, storniert
versendet  → bezahlt, storniert
bezahlt    → storniert
storniert  → —
```

**Ein** Übergangs-Regime für **alle** Schreibpfade. Der heutige Zustand — der
Zahlungsabgleich schreibt per Direkt-Update an der Übergangs-SSoT vorbei (W3) —
entfällt: auch der Zahlungsabgleich geht durch `isAllowedInvoiceStatusTransition`.
Sonst beschreibt die SSoT weiterhin nur die halbe Wirklichkeit.

---

## 5. Migration je Altwert

Bestand gemessen an der Referenz-Kopie (Stand 13.08.2026):

| Alt-Status | Typ | Anzahl | `sent_at` | Ziel |
|---|---|---|---|---|
| `entwurf` | rechnung | 10 | 0 | `entwurf` (unverändert) |
| `versendet` | rechnung | 172 | 172 | `versendet` (unverändert) |
| `avis_erhalten` | rechnung | 54 | 54 | **`versendet`** |
| `bezahlt` | rechnung | 73 | 73 | `bezahlt` (unverändert) |
| `storniert` | rechnung | 110 | 69 | `storniert` (unverändert) |
| `storniert` | nachberechnung | 4 | 0 | `storniert` (unverändert) |
| `teilweise_bezahlt` | — | **0** | — | `versendet` + Badge |
| `entwurf` | **stornorechnung** | **114** | **0** | **offen — siehe 7.1** |

### `avis_erhalten` → `versendet` (54 Zeilen)

Der Avis-Eingang bleibt als Zuordnungs-Information erhalten (er lebt in den
Qonto-/Avis-Tabellen, nicht in der Statusspalte). Der Status sagt danach das,
was er sagen soll: die Rechnung ist raus und noch nicht bezahlt.

Kein Informationsverlust: keine dieser 54 Rechnungen trägt `paid_at`.

### `teilweise_bezahlt` → `versendet` + Badge (0 Zeilen)

Heute leer. Der Fall ist trotzdem zu implementieren, weil er beim ersten
Teilzahlungs-Eingang eintritt — und heute (W1) als €-Summe an der falschen
Stelle im Cockpit-Board landen würde.

### Empfehlung zum Verfahren: **auditierter Einmal-Lauf**, nicht map-on-read

Alrik hat beide Wege zur Wahl gestellt. Meine Empfehlung ist der Einmal-Lauf,
aus drei Gründen:

1. **Der Status ist kein Dokument-Feld.** Er steht auf keiner Rechnung, in
   keinem PDF, in keiner ZUGFeRD-Datei. Was GoBD schützt — das ausgegebene
   Dokument und die Buchung — wird nicht berührt. Die Spalte ist interner
   Vorgangs-Zustand und wird heute schon routinemäßig fortgeschrieben (jeder
   Zahlungsabgleich schreibt sie).
2. **Map-on-read konserviert genau das Problem.** Der Altwert bliebe in der DB,
   und jeder Leser — heute und künftig — müsste die Abbildung kennen. Das ist
   derselbe Zweitbegriff, den dieser Umbau beseitigt, nur an anderer Stelle.
3. **Die Spur ist besser, nicht schlechter.** Ein Lauf mit einem
   Audit-Eintrag je Rechnung (`alt → neu`, Grund, Lauf-Referenz) ist
   nachvollziehbarer als eine Übersetzung, die nirgends protokolliert ist.

**Bedingungen**, ohne die der Lauf nicht stattfindet:
- Trockenlauf zuerst, Ergebnis an Alrik, ausdrückliche Freigabe.
- Ein Audit-Eintrag je geänderter Rechnung, mit Vorher-Wert.
- Scope hart auf die betroffenen Altwerte, kein „alles neu berechnen".
- Prod-Write nach den Hausregeln (Gate 4).

**Gegenargument, das ich nicht unterschlage:** map-on-read ist die
umkehrbarere Variante. Wer der Umstellung nicht traut, kann sie damit
schrittweise ausrollen und den Altwert als Rückfallebene behalten. Wenn Alrik
das vorzieht, ist der Preis eine Übersetzungsschicht, die dauerhaft
mitgeschleppt und irgendwann vergessen wird.

---

## 6. Was der Umbau anfasst (Blast-Radius)

Nicht abschließend erhoben — die Spec benennt die Ränder, die Umsetzung zählt
sie durch:

- `INVOICE_STATUSES`, `INVOICE_STATUS_LABELS` (`shared/schema/billing.ts`)
- `INVOICE_STATUS_TRANSITIONS` (`shared/domain/invoice-status.ts`)
- `assignInvoiceStage`, `assignInvoiceActionCluster`, `isStorniertInvoice`,
  `agingModelForBillingType` (`shared/domain/billing-pipeline.ts`)
- `resolveInvoicePaymentStatus` (`shared/domain/qonto/invoice-payment-status.ts`)
  — liefert künftig ein Badge, keinen Status
- die Schreibpfade des Zahlungsabgleichs (`server/routes/admin/qonto.ts`,
  `server/services/qonto.ts`)
- der manuelle Status-Endpoint und der Sammel-Statuswechsel
  (`server/routes/billing.ts`)
- Rechnungsliste, Cockpit-Board, Statistik (Client)
- der Avis-Backfill (`server/startup/backfill-avis-received-status.ts`) — nach
  der Migration gegenstandslos, gehört entfernt

---

## 7. Drei Stellen, an denen das Modell auf die Daten trifft

### 7.1 Die 114 Stornorechnungen — sie waren nie versandt

**Das ist die wichtigste offene Frage.**

Alrik: *„Endzustand ist abgeschlossen/versendet, nicht bezahlt — behebt die 114
auf entwurf."*

Gemessen: **alle 114 haben `sent_at = NULL`** — bei gesetztem `pdf_path`. Sie
wurden erzeugt, aber nie als versandt vermerkt. Zugleich referenziert jede genau
ein Original, und **alle 114 Originale stehen auf `storniert`**. Der
Storno-*Vorgang* ist also vollständig am Original verbucht; das Storno-*Dokument*
ist ein Nebenprodukt, das liegen blieb.

Sie auf `versendet` zu setzen hieße zu behaupten, sie seien rausgegangen. Das
weiß niemand, und `sent_at` widerspricht. **Ich würde das nicht tun.**

Drei Wege, alle mit Preis:

| | Was | Preis |
|---|---|---|
| **A** | Auf `entwurf` lassen; das Modell sagt, Stornorechnungen laufen den normalen Weg, diese hier sind schlicht nie versandt worden | Die „114 auf entwurf" bleiben — aber sie sind dann eine **richtige** Aussage und ein sichtbares operatives To-do statt eines Modell-Artefakts |
| **B** | `versendet` + `sent_at` aus einer belegbaren Quelle nachziehen (z. B. Storno-Zeitpunkt des Originals) | Nur zulässig, wenn die Dokumente tatsächlich zugestellt wurden. Sonst schreiben wir eine Unwahrheit in die Akte |
| **C** | `storniert` als terminaler Sammelzustand („nichts steht mehr aus") | Formal konsistent mit „terminal für alles Terminale", liest sich aber falsch: eine Stornorechnung ist nicht storniert |

**Meine Empfehlung: A.** Es ist die einzige Variante, die nichts behauptet. Und
sie fördert eine echte Frage zutage, die das Modell gar nicht beantworten kann:
*Sollen Stornorechnungen überhaupt versandt werden?* Wenn ja, fehlt ein
Arbeitsschritt. Wenn nein, ist `entwurf` für ein nie zu versendendes Dokument der
falsche Name — dann bräuchte es einen eigenen Ausgang, und das Modell hätte
einen fünften Status.

**Diese Frage gehört beantwortet, bevor gebaut wird.**

### 7.2 Stornorechnungen in den €-Summen

Heute sind Stornorechnungen über den **Typ** ein Side-Zustand und zählen in
**keine** Stufe. Wenn der Typ aufhört, den Zustand zu bestimmen (Abschnitt 2,
W4), wandern sie in die Stufen-Summen — mit ihren **negativen** Beträgen.

Größenordnung: die 114 tragen zusammen **−15.884,35 €**. Stünden sie auf
`versendet`, fiele diese Stufe von 23.748,53 € auf rund 7.864 €.

Das kann **richtig** sein (Netto-Sicht: was steht wirklich noch aus) oder
**falsch** (Doppelzählung, wenn das Original bereits als `storniert`
herausgerechnet ist). Nach dem heutigen Stand ist es Doppelzählung: das Original
ist bereits aus den Summen draußen, die Gutschrift zöge ein zweites Mal ab.

**Vorschlag:** Stornorechnungen bleiben aus den €-Summen der Stufen
ausgeschlossen — aber über eine **ausdrückliche Regel** („Storno-Dokumente
tragen keinen offenen Forderungsbetrag"), nicht als Nebenwirkung eines
Typ-basierten Side-Zustands. Der Unterschied ist wichtig: die Regel wird dann
benannt und geprüft, statt aus einer Enum-Zuordnung zu folgen.

### 7.3 Aging-Anker: bleibt der Empfänger-Unterschied hier zulässig?

„Empfänger-Unterschied raus" gilt für den **Status** — das ist eindeutig. Der
Aging-Anker ist aber eine Frage an das **Überfällig-Badge**: ab wann gilt eine
Rechnung als überfällig?

Heute: Selbstzahler ab `dueDate`, Kasse ab `sentAt`. Sachlich hat das einen
Grund (bei der Kasse liegt der Avis-Schritt dazwischen).

**Zwei Lesarten**, beide vertretbar:
- **eng**: Der Unterschied verlässt nur das Status-Modell; das Badge darf ihn
  behalten. Die Fälligkeit einer Kassenrechnung ist real eine andere.
- **weit**: Auch das Badge wird vereinheitlicht — alle Rechnungen altern ab
  `dueDate`. Dann braucht jede Kassenrechnung ein belastbares `dueDate`.

Ich neige zur **engen** Lesart, würde sie aber nicht selbst entscheiden: sie ist
die einzige Stelle, an der nach diesem Umbau noch „Kasse ≠ Kunde" steht, und das
sollte bewusst so bleiben, nicht übersehen worden sein.

---

## 8. Was diese Spec nicht regelt

- **Die Umsetzungsreihenfolge.** Naheliegend wäre: Ableitungen zuerst (ohne
  Datenänderung), dann die Schreibpfade, dann die Migration — aber das gehört in
  den Gate-1-Plan, nicht hierher.
- **Zahlungs-Tabellen und `paidAt`/`sentAt`** als eigene Wahrheitsquellen neben
  dem Status. Sie tauchen hier nur auf, wo sie die Migration betreffen.
- **Die Termin-Stufen** (`offen`/`dokumentiert`/`unterschrieben`), die sich das
  `PIPELINE_STAGES`-Enum mit den Rechnungs-Stufen teilen. Eigene Frage.
- **Wie viele gestellte Rechnungen auf Produktion betroffen sind.** Alle Zahlen
  hier stammen aus der Referenz-Kopie vom 13.08.; vor dem Migrations-Lauf ist
  auf Prod zu zählen.
