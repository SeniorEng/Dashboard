# Die 42 unsignierten Leistungsnachweise — Kassen-Exposition und Herkunft

- **Datum des Protokolls:** 17.09.2026
- **Ticket:** 6hWgf8W5hRq8W99G
- **Skripte (beide gelöscht nach Anwendung):**
  `docs/check-42er-kassenbelege.sql` (Lauf 1) und
  `docs/check-42er-zweiter-pfad.sql` (Lauf 2, Forensik)
- **Art:** ausschließlich lesend — `SET TRANSACTION READ ONLY` + `ROLLBACK`,
  zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'` beim Aufruf
- **Anwendung:** beide von Alrik gegen Prod gefahren, 17.09.2026
- **Maßnahme / Vorher-Nachher / Audit-Referenz:** entfallen — rein lesender
  Lauf, nichts geändert. Es gibt daher keine Audit-Spur zu diesem Protokoll.

## Warum gemessen wurde

Die Vormessung vom 16.09.2026
(`docs/corrections/2026-09-16_trigger-a-umfang-messung.md`, Block 4) fand
**42 Leistungsnachweise mit `status = 'completed'` und
`customer_signed_at IS NULL` bei 39 Kunden** — erwartet waren 0.

Der Zustand ist deshalb heikel, weil er durch **zwei** Maschen fällt:
`isServiceRecordSignedForBilling` (`shared/domain/billing-eligibility.ts`)
liest **nur den Status**, nie den Zeitstempel — für Pflegekasse ist
`completed` das *strenge* Gate, gerade weil die Kundenunterschrift der
Kassen-Nachweis ist. Gleichzeitig weist der LN-Renderer
(`server/lib/pdf-generator.ts`) einen Nachweis ohne Signaturdaten als „noch
nicht unterschrieben" aus.

Die Frage entschied die Priorisierung:

- **> 0** → bei diesen Kassen liegt ein Beleg, dessen beigelegter Nachweis
  keine Kundenunterschrift trägt. Frage an den Steuerberater bzw. die
  Kassen-Prüfpraxis.
- **= 0** → Datenhygiene am Import-Pfad.

## Die Prädikate — damit die Zahlen nachrechenbar bleiben

**Die 42er-Grundmenge:**

```sql
r.deleted_at IS NULL AND r.status = 'completed' AND r.customer_signed_at IS NULL
```

**Die Verknüpfung** Nachweis → Rechnung (es gibt keine direkte Referenz):

```
monthly_service_records → service_record_appointments → appointments
                       → invoice_line_items → invoices
```

**„Gestellte, aktive Kassen-Rechnung"** — zwei bewusste Abweichungen von der
Auftragsformulierung, beide in Block 3 nachgerechnet statt behauptet:

```sql
i.issued_at IS NOT NULL            -- SSoT „je ausgegeben", server/lib/invoice-issued.ts (#66)
AND i.status <> 'storniert'        -- kanonisch: activeInvoiceSqlRaw
AND i.invoice_type <> 'stornorechnung'
AND i.billing_type LIKE 'pflegekasse%'
```

1. **`issued_at` statt `sent_at`**: `sent_at` wird beim Zurücksetzen geleert
   und würde ausgegebene Belege unterschlagen.
2. **Nicht `storniert_at IS NULL` allein**: an echten Daten tragen **alle 114
   Gutschriften** `storniert_at = NULL` und wären als aktive Rechnung
   durchgegangen. Genau daran ist in dieser Serie schon einmal eine Zahl
   gescheitert.

## Ergebnis Lauf 1

| Block | Messung | Wert |
|---|---|---|
| 1 | Grundmenge — Befund vom 16.09. reproduziert | **42 Nachweise / 39 Kunden** |
| 2 | Davon an gestellter, aktiver Kassen-Rechnung | **0 Nachweise / 0 Rechnungen** |
| 5 | Herkunft laut Notiz-Prädikat: aus Altdaten-Import | 39 |
| 5 | Herkunft laut Notiz-Prädikat: andere | 3 → **Artefakt, siehe unten** |

**Kein Beleg bei einer Kasse trägt einen Nachweis ohne Kundenunterschrift.**
Eine Liste von Rechnungsnummern entfällt damit — Block 2b lieferte keine
Zeilen.

### Block 3 — die Null hängt nicht an einer Definitionswahl

Das ist der Grund, warum Block 3 gebaut wurde: eine Null, die nur unter *einer*
Lesart gilt, ist keine Entwarnung.

| Definition | Wert |
|---|---|
| kanonisch (`issued_at`, aktiv, Pflegekasse) — **die Zahl** | 0 |
| nur `storniert_at IS NULL` statt des kanonischen Aktiv-Prädikats | 0 |
| davon Gutschriften | 0 |
| über `sent_at` statt `issued_at` | 0 |

**Alle vier Varianten liefern 0.** Die Abweichungen von der
Auftragsformulierung ändern hier nichts — sie waren trotzdem richtig, nur
diesmal folgenlos. Hätte eine Variante abgewichen, stünde die Differenz hier.

### Block 4 — die Erhebung ist vollständig

Der Selbsttest: jeder der 42 Nachweise fällt in genau einen Topf, und die
Summe muss Block 1 ergeben.

| Topf | Wert |
|---|---|
| an gestellter Kassen-Rechnung | 0 |
| an gestellter Rechnung anderen Zahlers | 0 |
| nur an einer nicht ausgegebenen Rechnung | 0 |
| **ganz ohne Rechnung** | **42** |
| Summe | **42 ✓** |

Ohne diesen Block wäre „ist wirklich alles erfasst?" ein Argument gewesen
statt einer Zahl. Die Null aus Block 2 ist deshalb belastbar: die 42 sind
**noch gar nicht abgerechnet**.

## Was die Null NICHT heißt

Sie ist ein **Zeitfenster, kein Dauerzustand.**

Die 42 sind unabgerechnet. Werden sie abgerechnet, passieren sie das strenge
Gate — `isServiceRecordSignedForBilling` liest nur den Status —, und dann
entsteht genau der Fall, der hier mit 0 gemessen wurde. Die Messung sagt
„heute nicht", nicht „kann nicht".

Deshalb gehört der Fix **vor die nächste Abrechnung dieser 39 Kunden**, und
das ist kein Datum, das jemand im Blick hat. Greifbar wird es erst durch die
Bestandsbehandlung: solange die 42 nicht entweder signiert oder als
nicht-abrechenbar markiert sind, hängt die Null an einem Ereignis, das
jederzeit eintreten kann und niemanden alarmiert.

## Die 3 Nicht-Import-Fälle — aufgeklärt (Lauf 2, 17.09.2026)

Block 5 aus Lauf 1 erklärte 39 von 42 über den Altdaten-Import. Die drei
übrigen waren die wichtigere Frage: der Import ist ein Altlast-Pfad, ein
zweiter *aktiver* Pfad würde weiter solche Nachweise erzeugen.

**Ergebnis: es gibt keinen zweiten Erzeuger. Alle 42 stammen aus dem Import.**

### Die 39-vs-42-Differenz ist ein Prädikat-Artefakt, kein Befund

Das ist der Punkt, den ein späterer Leser sonst für einen Fund hält.

Block 5 aus Lauf 1 fragte: „hängt an diesem Nachweis ein Termin mit
`notes LIKE 'Import aus Altdaten%'`?" Lauf 2 (Block 2) zeigt, warum das bei
dreien NEIN ergab: die Termine **existieren**, sind **nicht soft-gelöscht** —
sie tragen nur **gar keine Notizen**, weder die Import-Notiz noch andere.

Das Prädikat prüfte also eine Eigenschaft, die nicht alle Import-Zeilen tragen.
Von den drei vorab formulierten Hypothesen trifft **H2** zu (Notiz fehlt/wurde
überschrieben), nicht H1 (keine Termine) oder H3 (hart gelöscht).

### Der Herkunfts-Beweis: die Anlage-Zeitfenster überlappen vollständig

| Gruppe | `created_at` von … bis |
|---|---|
| Import-Gruppe (39) | 2026-04-20 12:36:34 … 2026-07-09 12:10:42 |
| „andere Herkunft" (3) | 2026-04-20 12:36:35 … 2026-06-11 09:53:14 |

Die drei liegen **vollständig innerhalb** des Import-Fensters. Zwei davon
(LN 19 und 46) sind sekundengleich im selben Batch angelegt: 12:36:34 /
12:36:35 / 12:36:40. Ein zweiter, unabhängiger Schreibweg, der zufällig genau
dieselben Sekunden trifft, ist ausgeschlossen.

### Die Code-Suche hatte dasselbe Ergebnis

Auf dem heutigen Stand setzen genau zwei Pfade `status = 'completed'`:
`signServiceRecord` (atomar mit Zeitstempel — kann den Zustand nicht erzeugen)
und der Import. Geprüft und ausgeschlossen: der Storno-Pfad in
`server/routes/admin/audit.ts` (stuft immer mit zurück und verlangt vorhandene
Signaturdaten), beide Startup-Skripte (nur `deleted_at`/`updated_at`), die vier
in #116 abgelegten Einmal-Skripte, `fix-replit-1913-restore-13.ts` (nur
`appointments`) und `audit-empty-signatures.ts` (read-only, und es verlangt
`customer_signature_data IS NOT NULL`, sieht die 42 also gar nicht — es
adressiert die benachbarte Klasse aus Task #749: `completed` mit *leerem*
Signaturbild statt *fehlendem* Zeitstempel).

### Kontext aus Block 5 (Lauf 2)

42 von 910 `completed`-Nachweisen (4,6 %) tragen keinen der beiden Zeitstempel.
`pending` (5) und `employee_signed` (4) sind statusgemäß unauffällig — dort ist
ein fehlender Kunden-Zeitstempel der Normalzustand.

### Nebenbefund: die Massenanlage läuft ohne Audit-Spur

Block 3 aus Lauf 2 lieferte **null Zeilen** Audit-Log zu den drei Nachweisen.

Die Lesehilfe im Skript sagte dazu „leer ⇒ außerhalb der App entstanden" —
**das war zu schnell geschlossen**, denn der Import läuft in der App. Im Code
nachgeprüft trifft die andere Erklärung zu:

- `createServiceRecordsForImported` schreibt **keinen** Audit-Eintrag.
- `storage.createServiceRecord` ebenfalls nicht — es ist ein reiner Insert.
- Der Helfer `auditService.serviceRecordCreated` existiert, wird aber
  ausschließlich von den zwei interaktiven Routen in
  `server/routes/service-records.ts` gerufen.
- Die beiden Audit-Aufrufe in `appointment-import.ts` betreffen
  `appointment`-Entitäten (`appointment_km_rebooked`), nicht Nachweise.

Es entstanden also 42 Leistungsnachweise in Massenanlage, ohne dass ein
einziger Audit-Eintrag sie ausweist — GoBD-relevant und ein **eigener**
Befund, nicht Teil des Haupt-Fixes. Verfolgt im Ticket.

## Verbleib der beiden Skripte

Einmal-Werkzeuge nach der Regel in `CLAUDE.md`: der vollständige Nachweis ist
git-Historie plus dieses Protokoll. Die Prädikate stehen oben inline, die
Messung ist also ohne git-Archäologie nachvollziehbar.

| Skript | Verbleib |
|---|---|
| `docs/check-42er-kassenbelege.sql` (Lauf 1) | angewendet, gelöscht — `git show a174f8c1:docs/check-42er-kassenbelege.sql` |
| `docs/check-42er-zweiter-pfad.sql` (Lauf 2) | angewendet, gelöscht — `git show 581ebc65:docs/check-42er-zweiter-pfad.sql` |

Beide lagen zunächst auf `einmal/verify-42er-kassenbelege` (Head
`8c53b8d43fcf38fad909cacf0ea51469687c8c07`, Basis `cf4df897`). Weil Lauf 2 zum
Zeitpunkt der Branch-Löschung noch ausstand, wurde die Forensik vorher
unverändert auf `einmal/verify-42er-zweiter-pfad` gerettet (Blob-Identität
geprüft) und erst nach ihrem Prod-Lauf abgelegt.
