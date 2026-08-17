# Inventar: Wo wird „Kunde × Mitarbeiter × Monat" als unteilbare Einheit behandelt?

**Read-only. Kein Code geändert.** Erhoben am 17.08.2026 gegen `main` (`b85bc360`)
und die Referenz-Kopie. Anlass: der Nachweise-Bug (dokumentierter, unbebündelter
Termin fiel in keine Kategorie) — die Frage war, ob dieselbe Annahme anderswo
sitzt.

**Kurzfassung: Sie sitzt weit seltener, als der Bug vermuten ließ.** Von sieben
geprüften Stellen sind **zwei** Bugs (beide behoben) und **fünf** entweder
bewusst ganzheitlich oder längst teilbar gebaut. Die
Abrechnung ist der Bereich, der die Teilbarkeit am saubersten löst — sie taugt
als Muster für alles Weitere.

---

## 1. Nachweis bündeln — **BUG, behoben** (PR `fix/teilweises-buendeln`)

**Wo:** `POST /api/service-records` · `GET /overview` · `GET /check-period`
(dieselbe Formel dreimal) plus `bucketize()` im Client.

**Was:** Ein einziger offener Termin sperrte das Bündeln der bereits
dokumentierten — und die Übersicht zeigte das Bereit-Signal gar nicht erst an.

**Warum Bug:** Die Einheit ist hier falsch gewählt. Abrechenbar ist der EINZELNE
dokumentierte Termin; der Monat ist nur der Behälter. Der Mischzustand ist im
laufenden Monat der Normalfall, nicht die Ausnahme.

**Beleg:** In der Referenz-Kopie 11 betroffene Fälle / 12 blockierte
dokumentierte Termine / 6 Kräfte / 11 Kunden.

---

## 2. Sammel-Rechnung `generate-all` — **GEWOLLT und sauber gelöst**

**Wo:** `POST /api/billing/generate-all` (`server/routes/billing.ts:3550 ff.`)

**Was:** Rechnet über einen Monat, kennt aber **drei** ausdrückliche Wege in die
Teilbarkeit:

| Schalter | Bedeutung |
|---|---|
| `dateFrom`/`dateTo` (#1317) | Teil-Abrechnung innerhalb des Monats |
| `readyOnly` (#1771) | nur Kunden ohne offene Termine; die anderen werden **ausgewiesen übersprungen**, nicht still |
| `confirmPartial` (#1883) | bewusstes Teil-Abrechnen mit Begründung |

**Warum gewollt:** Eine Rechnung ist ein Dokument mit Zeitraum — sie DARF den
Monat als Einheit nehmen. Entscheidend ist, dass die Ganzheit hier **Default,
nicht Zwang** ist, und dass Übersprungenes gemeldet wird.

**Das ist das Muster**, an dem sich die anderen Stellen messen lassen sollten:
ganzheitlich als Vorgabe, teilbar auf Ansage, nie still.

---

## 3. Rechnung aus Leistungsnachweisen — **schon teilbar**

**Wo:** `server/services/invoice-calc.ts:281`

```ts
const signedRecords = serviceRecords.filter(sr => isServiceRecordSignedForBilling(...));
```

**Was:** Der Rechnungslauf arbeitet über eine **Liste** signierter Nachweise, nicht
über „den" Monats-Nachweis. Mehrere Sammel-LN pro Kunden-Monat sind hier bereits
vorgesehen.

**Befund:** Keine Atomaritäts-Annahme. Der Pending-Unique-Index, der genau das
erzwungen hätte, wurde mit #1542 ausdrücklich entfernt.

**Vorbehalt:** Ich habe die Konsumenten dieser Liste nicht erschöpfend
durchgezählt — PDF-Erzeugung und §45b-Buchung stehen im laufenden Gate-2-Review
zum Bündel-PR ausdrücklich auf der Prüfliste. Bis der zurück ist, ist dieser
Punkt „plausibel geprüft", nicht „bewiesen".

---

## 4. Monatsabschluss — **bewusst NICHT atomar (seit #1496)**

**Wo:** `server/services/month-close-scheduler.ts:180 ff.`

```
Der Auto-Close ist die EINZIGE Abschluss-Mechanik und schließt BEDINGUNGSLOS —
jeder Mitarbeiter mit Aktivität im Vormonat wird am Cutoff geschlossen,
UNABHÄNGIG von offenen/undokumentierten/unsignierten Terminen.
```

**Befund:** Hier wurde die Atomarität schon einmal bewusst aufgegeben. Offene
Termine werden zu „Nicht abgerechnet" (abgeleitet), fehlende Unterschriften
wandern in eine eigene Liste. `getMonthClosingReadiness` liefert weiterhin
Zählungen — aber nur noch informativ, nicht mehr blockierend.

**Für uns wichtig:** Das ist der Präzedenzfall. Die Entscheidung „unvollständig
ist ein Zustand, kein Fehler" ist im Monatsabschluss bereits gefallen.

---

## 5. Kunde deaktivieren — **war ein Bug, ENTSCHIEDEN und behoben**

**Wo:** `server/routes/admin/customers/workflows.ts:351, 408, 412`

**Was:** Drei harte Gates, das erste ausdrücklich **auch per Superadmin-Override
nicht überspringbar**:

1. alle Termine bis Vertragsende dokumentiert
2. für jeden berührten Monat ein Leistungsnachweis
3. für jeden berührten Monat eine Rechnung

**Warum vermutlich gewollt:** Einen Kunden zu deaktivieren, dessen Leistungen nie
abgerechnet wurden, verliert Geld und Nachweis. Das Gate schützt echten Wert.

**Warum trotzdem auf die Liste:** Gate 1 ist *härter als jedes andere im System* —
selbst die GF kommt nicht daran vorbei. Wenn ein Kunde verstirbt und ein
undokumentierter Termin stehenbleibt, ist die Deaktivierung **dauerhaft
blockiert**, bis jemand rückwirkend dokumentiert. Ob das gewollt ist oder nur nie
zu Ende gedacht wurde, kann ich aus dem Code nicht entscheiden.

**Entscheidung (Alrik, 17.08.2026): ja.** Gate 1 ist seit
`fix/deaktivierung-gate1-override` über denselben `overrideBillingGates`-Schalter
übergehbar wie Gate 2 und 3 — Superadmin-only, Pflicht-Begründung, Audit-Eintrag
mit den konkreten Termin-IDs. Das Vertragsende bleibt hart.

**Vorher geklärt, weil es den Warntext bestimmt:** die undokumentierten Termine
verschwinden NICHT. Weder die Nachweis-Übersicht noch der Abrechnungspfad noch
die Dokumentations-Policy sehen `customers.status` an; in der Referenz-Kopie
stehen bereits 20 dokumentierte, unbebündelte Termine bei inaktiven Kunden. Die
Warnung spricht deshalb nicht von Verlust, sondern von dem, was tatsächlich
wegfällt: die Erinnerung.

---

## 6. Dokumentieren nach Monatsabschluss — **GEWOLLT**

**Wo:** `server/routes/appointment-documentation.ts:65`

**Was:** Ein Termin in einem geschlossenen Monat kann nur von der GF geändert
werden (`MONTH_CLOSED`).

**Warum gewollt:** Der Monat ist hier tatsächlich die richtige Einheit — Lohn und
Stunden sind für ihn festgestellt. Das ist keine Atomarität der Arbeit, sondern
die Unumkehrbarkeit einer Feststellung.

**Randnotiz:** Das Erstellen eines Nachweises ist seit #1496 ausdrücklich NICHT
mehr gesperrt (ein LN bewegt kein Geld). Die Grenze verläuft also schon heute
zwischen „dokumentieren" und „nachweisen" — genau richtig.

---

## 7. Abrechnungs-Übersicht: Kundengruppierung — **schon teilbar**

**Wo:** `server/routes/billing.ts:586 ff.`

**Was:** Ausgeschlossen wird nur der **vollständig** abgerechnete Kunde. Der
Kommentar dort beschreibt einen früheren Bug derselben Familie: ein Kunde mit
teilweise abgerechneter Aktivität „sah dadurch vollständig abgerechnet aus und
verschwand still aus der Liste".

**Befund:** Dieselbe Klasse Fehler wurde hier schon einmal gefunden und behoben.
Die Aufmerksamkeits-Gruppen („Unvollständig dokumentiert" / „Wartet auf …")
existieren genau dafür.

---

## Was ich NICHT geprüft habe

- **§45b-Budget-Pfade.** Carryover, FIFO und Verfall rechnen über Monate, aber
  die Frage „ist ein Monat teilbar?" stellt sich dort anders (Geld, nicht
  Arbeitsfortschritt). Eigenes Thema, eigene Erhebung.
- **Statistik/Process-Health.** Zählt, blockiert nicht — für die Frage nach
  Teilarbeit irrelevant, aber die Kennzahlen könnten nach dem Bündel-PR anders
  aussehen (mehrere LN pro Monat).
- **Der Client jenseits der Nachweis-Übersicht.** Ich habe nach Gates gesucht,
  nicht nach Anzeigen, die stillschweigend „ein LN pro Monat" annehmen.

## Stand

- **Punkt 1** behoben (`fix/teilweises-buendeln`).
- **Punkt 5** entschieden und behoben (`fix/deaktivierung-gate1-override`).
- **Punkt 3** ist noch „plausibel geprüft", nicht bewiesen — der Gate-2-Review
  zum Bündel-PR prüft die Konsumenten mehrerer Sammel-LN pro Monat ausdrücklich
  mit. Bis der zurück ist, bleibt der Punkt offen.
- Alles andere braucht keine Änderung.

## Fußnote: was dieses Inventar NICHT belegt

Es ist eine Erhebung von einem Tag, entstanden aus einem konkreten Bug — kein
vollständiger Audit. Drei Ecken sind ausdrücklich ungeprüft (§45b-Budget-Pfade,
Statistik/Process-Health, der Client jenseits der Nachweis-Übersicht), und
Punkt 3 steht auf einer Stichprobe statt auf einer Durchzählung. Wer hier eine
Stelle sucht und nicht findet, hat damit nicht bewiesen, dass es sie nicht gibt.
