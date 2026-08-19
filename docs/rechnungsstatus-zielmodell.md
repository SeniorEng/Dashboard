# Rechnungsstatus — Ziel-Modell (Spezifikation)

**Schritt 2 zum Aufräum-Task. Design-Doc, kein Code.** Erst nach Freigabe dieser
Spec wurde gebaut.

**Umgesetzt.** Was davon abweicht und was beim Bauen dazukam, steht im
[Umsetzungs-Nachtrag](#9-umsetzungs-nachtrag-19082026) am Ende — die Spec selbst
ist der Stand vor der Umsetzung und wurde nicht rückwirkend geglättet.

Grundlage ist die Bestandsaufnahme in [`statusmodell-karte.md`](./statusmodell-karte.md)
— dort steht, was es heute gibt und wo es sich widerspricht. Hier steht, was es
werden soll.

**Modell final, alle Entscheidungen bestätigt von Alrik am 17.08.2026.** Diese
Spec schreibt es aus: Modell, Ableitungsregeln, Übergänge, Migration.

Die drei Stellen, an denen das Modell auf die vorhandenen Daten traf, sind
entschieden — sie stehen in Abschnitt 7 mit der jeweiligen Entscheidung und
ihrer Begründung, damit später nachvollziehbar bleibt, warum es so und nicht
anders aussieht.

---

## 1. Das Modell

### Gespeichert: vier Status für Rechnungen, ein eigener für Storno-Dokumente

**Normale Rechnungen** (`invoice_type = rechnung`) durchlaufen genau vier:

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

**Storno-Dokumente** (`invoice_type = stornorechnung`) haben genau einen:

| Status | Bedeutung |
|---|---|
| `abgeschlossen` | Das Dokument **entsteht fertig**. Es ist kein Entwurf (nichts daran zu entscheiden), wird nie bezahlt (es fordert nichts) und wird nie storniert (der Storno IST es). |

Ein Storno-Dokument ist die Belegseite eines Vorgangs, der am **Original**
verbucht ist — dort steht `storniert`. Das Dokument selbst hat keinen
Lebenszyklus, es hat einen Zustand: erledigt.

**Damit lösen sich die „114 auf `entwurf`" auf.** Sie standen dort nicht, weil
jemand vergessen hätte weiterzuklicken, sondern weil das Modell für ihren
tatsächlichen Zustand keinen Namen hatte.

`abgeschlossen` ist ausdrücklich **kein** Ausgang für normale Rechnungen. Eine
Rechnung, die nichts mehr einbringt, geht nach `storniert` — das ist die Regel
„terminal für alles Terminale", und sie bleibt unangetastet.

> **Zum Namen:** `abgeschlossen` existiert bereits als **Cluster**-Wert (für
> bezahlte Rechnungen). Das ist keine Kollision, sondern dieselbe Aussage auf
> zwei Ebenen: eine bezahlte Rechnung und ein Storno-Dokument sind beide fertig
> und landen beide im Cluster „Abgeschlossen". Der Status sagt *warum*, der
> Cluster sagt *dass*. Wer die Enums liest, soll das hier gelesen haben und
> nicht für ein Versehen halten.

### Abgeleitet: zwei Badges, kein Status

| Badge | Regel | Quelle |
|---|---|---|
| **Teilweise bezahlt** | `0 < Σ gezahlt < Brutto` | Zahlungssumme, nicht Statusspalte |
| **Überfällig** | unbezahlt **und** Fälligkeit überschritten | `dueDate` bzw. Zahler-Anker |
| **Versandt** | `sent_at` gesetzt | Zeitstempel, nicht Status |

Das **Versandt**-Badge gehört zum Storno-Dokument: dass eine Stornorechnung
verschickt wurde, ist ein Kennzeichen am Beleg, kein Zustandswechsel — sie war
vorher fertig und ist es nachher. Bei normalen Rechnungen sagt der Status
`versendet` dasselbe bereits; dort ist das Badge redundant und wird nicht
angezeigt.

Damit ist auch die Frage beantwortet, die die Bestandsaufnahme offen ließ:
Storno-Dokumente DÜRFEN verschickt werden, und ob sie es wurden, ist ablesbar —
ohne dass ein Status dafür herhalten muss.

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

**Genau eine Ausnahme, bewusst und benannt:** der **Aging-Anker**. Selbstzahler
altern ab Fälligkeitsdatum, Kassenrechnungen ab Versanddatum. Das ist eine Frage
an das **Überfällig-Badge**, nicht an den Status — und sie ist sachlich
begründet: bei der Kasse liegt zwischen Versand und Zahlung der Avis-Schritt,
beim Kunden nicht.

Das ist nach diesem Umbau die **einzige** Stelle im gesamten Rechnungswesen, an
der noch „Kasse ≠ Kunde" steht. Sie steht dort absichtlich. Wer sie später
findet und für einen Rest der alten Vermischung hält, soll hier lesen, dass sie
geprüft und behalten wurde. Ausgeschrieben in Abschnitt 7.3.

---

## 2. SSoT-Zuordnung

| Was | Wo | Art |
|---|---|---|
| **Status** | `invoices.status` | **einzige gespeicherte Wahrheit** |
| Pipeline-Stufe | abgeleitet aus Status + Typ | rein abgeleitet |
| Handlungs-Cluster | abgeleitet aus Stufe + Zahlungsbindung | rein abgeleitet |
| Teilzahlung | abgeleitet aus der Zahlungssumme | **Badge**, nie Status |
| Überfälligkeit | abgeleitet aus Zahlungsstand + Frist | **Badge**, nie Status |
| Versand eines Storno-Dokuments | `invoices.sent_at` | **Badge**, nie Status |

Damit lösen sich drei Widersprüche der Bestandsaufnahme auf:

- **W1** (`teilweise_bezahlt` auf zwei Ebenen) — es gibt den Status nicht mehr.
- **W2** (Ableitung schreibt Spalte) — der Zahlungsabgleich schreibt nur noch
  `bezahlt`, und das ist ein echter Zustandswechsel, keine Ableitung.
- **W4** (`storniert` zweimal ausdrückbar) — der Typ sagt nichts mehr über den
  Zustand. Storniert ist, was `status = 'storniert'` hat; ein Storno-Dokument
  ist `abgeschlossen`, nicht storniert.

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
status = storniert     → side: storniert       (zählt in keine Stufe)
status = abgeschlossen → side: storno_dokument (zählt in keine Stufe, siehe 4.4)
status = entwurf       → stage: rechnung_erstellt
status = versendet     → stage: versendet
status = bezahlt       → stage: bezahlt
sonst                  → FEHLER
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
side: storno_dokument                    → abgeschlossen
hasBoundPayment && stage = versendet     → zahlung_zugeordnet_pruefung
stage = rechnung_erstellt                → zu_versenden
stage = versendet                        → zahlung_ausstehend
stage = bezahlt                          → abgeschlossen
```

Der Zahler-Typ kommt hier **nicht mehr vor**. Das ist die konkrete Wirkung von
„Empfänger-Unterschied raus".

### 4.4 Storno-Dokumente tragen keinen offenen Forderungsbetrag

**Ausdrückliche Regel, kein Nebeneffekt.**

Ein Storno-Dokument geht in **keine** €-Summe der Pipeline ein. Nicht, weil sein
Typ zufällig in einen Side-Zustand fällt — sondern weil es fachlich keine
offene Forderung ausweist: der Betrag, den es aufhebt, ist bereits am Original
herausgerechnet (dort steht `storniert`, und stornierte Rechnungen zählen in
keine Stufe).

Beide mitzuzählen wäre eine **Doppelzählung**. Größenordnung, falls es doch
geschähe: die 114 Storno-Dokumente tragen zusammen −15.884,35 €; sie würden die
Stufe `versendet` von 23.748,53 € auf rund 7.864 € drücken — eine Zahl, die
nichts Reales beschreibt.

Warum das hier als eigener Abschnitt steht: heute folgt derselbe Ausschluss
**implizit** aus dem typ-basierten Side-Zustand. Sobald der Typ aufhört, den
Zustand zu bestimmen (Abschnitt 2, W4), verschwindet der Ausschluss mit ihm —
lautlos. Die Regel muss also benannt und geprüft werden, nicht geerbt.

**Umsetzungshinweis:** ein Test, der genau diese Aussage festhält („die Summe
über alle Stufen enthält keinen Storno-Betrag"), gehört zum
Implementierungs-PR. Ohne ihn ist die Regel eine Absichtserklärung.

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

**Normale Rechnungen:**

```
entwurf    → versendet, storniert
versendet  → bezahlt, storniert
bezahlt    → storniert
storniert  → —
```

**Storno-Dokumente:** keine. Sie entstehen auf `abgeschlossen` und bleiben dort.
Es gibt keinen Übergang hinein (außer der Anlage) und keinen hinaus. Ein
Storno-Dokument zu stornieren ist kein Vorgang, den das Modell kennt — wer den
Storno rückgängig machen will, stellt neu aus.

Das `sent_at`-Kennzeichen wird davon unabhängig gesetzt und ist **kein**
Übergang.

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
| `entwurf` | **stornorechnung** | **114** | **0** | **`abgeschlossen`** |

### `avis_erhalten` → `versendet` (54 Zeilen)

Der Avis-Eingang bleibt als Zuordnungs-Information erhalten (er lebt in den
Qonto-/Avis-Tabellen, nicht in der Statusspalte). Der Status sagt danach das,
was er sagen soll: die Rechnung ist raus und noch nicht bezahlt.

Kein Informationsverlust: keine dieser 54 Rechnungen trägt `paid_at`.

### `teilweise_bezahlt` → `versendet` + Badge (0 Zeilen)

Heute leer. Der Fall ist trotzdem zu implementieren, weil er beim ersten
Teilzahlungs-Eingang eintritt — und heute (W1) als €-Summe an der falschen
Stelle im Cockpit-Board landen würde.

### `entwurf` (stornorechnung) → `abgeschlossen` (114 Zeilen)

Kein Statuswechsel im eigentlichen Sinn, sondern eine **Korrektur der
Benennung**: diese Dokumente waren nie Entwürfe. Sie sind fertig, seit sie
existieren — es gab bloß kein Wort dafür.

`sent_at` wird dabei **nicht** angefasst. Es bleibt `NULL`, weil niemand weiß,
ob die Dokumente je verschickt wurden. Nach der Migration sagt die Akte damit
genau das Richtige: *fertig, nicht versandt.* Falls sich herausstellt, dass sie
zugestellt wurden, ist das ein eigener, belegbarer Nachtrag — kein Beiwerk
dieser Migration.

### Verfahren: **auditierter Einmal-Lauf** (entschieden)

Alrik hat entschieden: Einmal-Lauf, nicht map-on-read. Die Gründe, damit die
Entscheidung nachvollziehbar bleibt:

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

**Was dabei aufgegeben wird, ausdrücklich:** map-on-read wäre die umkehrbarere
Variante gewesen — der Altwert bliebe als Rückfallebene stehen. Der Preis dafür
wäre eine Übersetzungsschicht, die dauerhaft mitgeschleppt und irgendwann
vergessen wird. Diese Umkehrbarkeit wird bewusst gegen Klarheit eingetauscht.
Die Sicherung ist stattdessen der Audit-Eintrag je Zeile: aus ihm ist der
Vorher-Zustand jederzeit rekonstruierbar.

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
- der Anlagepfad der Stornorechnung: sie entsteht künftig auf `abgeschlossen`,
  nicht auf `entwurf`
- der Entwurfs-Löschpfad: er darf Storno-Dokumente nicht mehr erfassen (sie sind
  keine Entwürfe mehr — heute sind sie es, und das ist eine Löschgefahr, die mit
  dem neuen Zustand von selbst verschwindet)
- der Test, der Abschnitt 4.4 festhält (neu)

---

## 7. Die drei Entscheidungen, ausgeschrieben

Hier stand in der Entwurfsfassung, was zu entscheiden war. Jetzt steht hier, wie
entschieden wurde und warum — damit in einem Jahr niemand raten muss.

### 7.1 Die 114 Storno-Dokumente → eigener Endzustand `abgeschlossen`

**Der Befund:** alle 114 haben `sent_at = NULL` bei gesetztem `pdf_path`. Jede
referenziert genau ein Original, und alle 114 Originale stehen auf `storniert`.

Damit war klar, was sie sind: **fertige Belege zu einem anderswo verbuchten
Vorgang**. Weder Entwürfe (es ist nichts zu entscheiden) noch Zahlungserwartung
(sie fordern nichts) noch stornierbar (sie SIND der Storno).

**Entschieden:** eigener Endzustand `abgeschlossen`, ausschließlich für
Storno-Dokumente. Sie entstehen darin.

Verworfen wurden:
- **`versendet`** — hätte behauptet, sie seien rausgegangen; `sent_at`
  widerspricht.
- **`entwurf` belassen** — wäre nicht falsch gewesen, aber es hätte einen
  richtigen Zustand mit einem falschen Wort benannt und die Frage offen
  gelassen.
- **`storniert`** — formal konsistent, liest sich aber falsch: eine
  Stornorechnung ist nicht storniert.

Die Frage, die dabei auftauchte — *sollen Storno-Dokumente überhaupt verschickt
werden?* — ist mit dem `sent_at`-Badge beantwortet: sie **dürfen**, und ob sie
es wurden, ist ablesbar. Kein Status muss dafür herhalten.

### 7.2 Storno-Dokumente aus den €-Summen — als benannte Regel

**Entschieden:** Ausschluss bleibt, aber ausdrücklich formuliert statt aus dem
Typ geerbt. Ausgeschrieben in Abschnitt 4.4, samt Test-Auftrag.

Der Unterschied ist nicht kosmetisch: heute folgt der Ausschluss aus einer
Enum-Zuordnung, die dieser Umbau gerade beseitigt. Ohne die benannte Regel
verschwände er lautlos mit ihr — und die Stufen-Summen wären um −15.884,35 €
falsch, ohne dass irgendetwas rot würde.

### 7.3 Aging-Anker behält „Kasse ≠ Kunde"

**Entschieden:** enge Lesart. Der Empfänger-Unterschied verlässt das
**Status-Modell** vollständig, bleibt aber beim **Überfälligkeits-Timing**:

- Selbstzahler/Privat: Anker `dueDate` (Fälligkeit)
- Pflegekasse: Anker `sentAt` (Versand, vor Avis-Eingang)

Begründung: es sind zwei verschiedene reale Abläufe. Bei der Kasse liegt der
Avis-Schritt zwischen Versand und Zahlung; „überfällig ab Fälligkeitsdatum"
würde dort Rechnungen anmahnen, die im normalen Lauf sind.

**Diese Stelle ist als einzige legitime Empfänger-Unterscheidung benannt.** Alles
andere — Status, Stufe, Cluster — ist danach empfängerblind. Wer künftig eine
zweite Stelle mit `billingType` findet, hat einen Rückfall gefunden, keinen
Rest.

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

---

## 9. Umsetzungs-Nachtrag (19.08.2026)

Gebaut in PR #108, nachgezogen in #111/#112. Das Modell aus Abschnitt 1 ist
unverändert umgesetzt. Hier steht nur, was davon abweicht oder beim Bauen
dazukam — damit diese Spec nicht mehr verspricht, als in `main` steht.

### 9.1 Korrektur in dieser Spec

Die Überschrift in Abschnitt 1 sagt „zwei Badges". Es sind **drei**; die Tabelle
darunter listet sie korrekt (Teilweise bezahlt · Überfällig · Versandt).

### 9.2 „Migration vor Deploy" ist keine Anweisung mehr, sondern eine Bedingung

Abschnitt 5 nennt die Reihenfolge — Migration zuerst, dann Deploy —, weil der
neue Code die Altwerte nicht mehr lesen kann. Am 18.08.2026 lief der Publish
trotzdem **28 Minuten vor** der Migration. 54 Zeilen trugen weiter
`avis_erhalten`; `parseInvoiceStatus` warf, und der Wurf riss nicht die einzelne
Zeile mit, sondern den ganzen Lesepfad: Rechnungsliste und Cockpit-Board
antworteten rund eine Stunde mit 500.

Die Reihenfolge steht deshalb nicht mehr nur hier. Ein Boot-Gate
(`server/startup/assert-invoice-status-domain.ts`, PR #112) schickt vor dem
Serving jeden vorkommenden `invoices.status`-Wert durch `parseInvoiceStatus` und
beendet den Prozess bei einem Treffer — der Deploy schlägt fehl, die alte
Version bleibt online.

### 9.3 Verfeinerungen aus dem Review

Elf bestätigte Blocker über zwei Runden. Drei betreffen das Modell selbst:

**Die Zahlungs-Rücknahme brauchte eine eigene Übergangs-Map.** Abschnitt 4
beschreibt ein Übergangs-Regime für alle Schreibpfade. Beim Vereinheitlichen
zeigte sich, dass die Map nur den **manuellen** Weg beschrieb: der Qonto-Unmatch
(`bezahlt → versendet`) fiel durch. Der Übergang ist legitim, wenn eine
gebundene Zahlung wegfällt — aber nicht als Handgriff im Status-Menü, sonst
verschleiert er einen Zahlungseingang. Umgesetzt als eigene, benannte
`INVOICE_STATUS_REVERSAL_TRANSITIONS` mit ausdrücklichem Opt-in, aus der beide
Rücknahme-Pfade ableiten.

**`isStorniertInvoice` ist auf den Status verengt worden**, weil der Typ nach
dem Umbau nichts mehr über den Zustand sagt. Der TS-Zwilling von
`activeInvoiceCondition()` heißt seither `istAktionsfaehigeRechnung`; die
SSoT-Registry ist entsprechend nachgezogen. Wer „zählt diese Rechnung noch?"
fragt, greift zu dieser Funktion, nicht mehr zu `isStorniertInvoice`.

**`resolveInvoicePaymentStatus` liefert nur noch `"bezahlt" | null`** — die
Unterzahlung setzt keinen Status mehr (Abschnitt 3). Damit bedeutet `null` seit
dem Umbau **zwei** Dinge: Unterzahlung (normal) und Über-Toleranz-Überzahlung
(Prüffall). Wer weiter auf `status === null` verzweigt, wirft beide zusammen und
meldet jede Teilzahlung als Mismatch. Die Schreibpfade verzweigen deshalb über
`classification.result`, nicht über den Status.

**Storno-Dokumente bleiben im Cluster `storniert`.** Der Status `abgeschlossen`
(7.1) beschreibt das Dokument; der Cluster gruppiert die Rechnungsliste und
trägt je Gruppe eine €-Summe. Storno-Dokumente tragen negative Beträge — in
„Bezahlt — abgeschlossen" hätten sie die Summe um −15.884,35 € verfälscht,
während „Stornierte Rechnungen und Gutschriften" die Gegenbuchung verloren
hätte, die sich dort gegen die Originale aufhebt.

### 9.4 Nicht Gegenstand dieser Spec: der Leistungsnachweis-Fingerprint

Der `leistungsnachweisDataFingerprint` (Drift-Anzeige) wird hier nirgends
geregelt und ist auch nicht Teil des Status-Modells. Er wurde parallel als
**Stopgap** umgesetzt: `istLeistungsnachweisDrift` (`server/routes/billing.ts`)
vergleicht den gespeicherten Wert gegen **beide** Live-Fingerprints und meldet
Drift nur, wenn er zu keinem passt — kein Backfill, kein gespeicherter Wert wird
angefasst. Grund: eine korrigierte Formel allein träfe Rechnungen, die mit dem
alten Wert eingefroren wurden. Die Auflösung (Formel korrigieren + Backfill) ist
ein eigener Task; sie gehört nicht in diese Spec.
