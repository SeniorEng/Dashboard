# Hängen die 42 unsignierten Leistungsnachweise an Kassen-Belegen?

- **Datum des Protokolls:** 17.09.2026
- **Ticket:** 6hWgf8W5hRq8W99G
- **Skript (gelöscht nach Anwendung):** `docs/check-42er-kassenbelege.sql`
- **Art:** ausschließlich lesend — `SET TRANSACTION READ ONLY` + `ROLLBACK`,
  zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'` beim Aufruf
- **Anwendung:** von Alrik gegen Prod gefahren, 17.09.2026
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

## Ergebnis

| Block | Messung | Wert |
|---|---|---|
| 1 | Grundmenge — Befund vom 16.09. reproduziert | **42 Nachweise / 39 Kunden** |
| 2 | Davon an gestellter, aktiver Kassen-Rechnung | **0 Nachweise / 0 Rechnungen** |
| 5 | Herkunft: aus Altdaten-Import | 39 |
| 5 | Herkunft: **andere** | **3** |

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

## Offen: die 3 Nicht-Import-Fälle

Block 5 erklärt 39 von 42 über den Altdaten-Import
(`createServiceRecordsForImported` in `server/services/appointment-import.ts`).
**Drei bleiben unerklärt** — und das ist die wichtigere Frage: der Import ist
ein Altlast-Pfad, ein zweiter *aktiver* Pfad würde weiter solche Nachweise
erzeugen.

Die Code-Suche ist gefahren und hat **keinen** zweiten Erzeuger gefunden. Auf
dem heutigen Stand setzen genau zwei Pfade `status = 'completed'`:
`signServiceRecord` (atomar mit Zeitstempel — kann den Zustand nicht erzeugen)
und der Import. Geprüft und ausgeschlossen: der Storno-Pfad in
`server/routes/admin/audit.ts` (stuft immer mit zurück und verlangt vorhandene
Signaturdaten), beide Startup-Skripte (nur `deleted_at`/`updated_at`), die vier
in #116 abgelegten Einmal-Skripte, `fix-replit-1913-restore-13.ts` (nur
`appointments`) und `audit-empty-signatures.ts` (read-only, und es verlangt
`customer_signature_data IS NOT NULL`, sieht die 42 also gar nicht — es
adressiert die benachbarte Klasse aus Task #749: `completed` mit *leerem*
Signaturbild statt *fehlendem* Zeitstempel).

Arbeitshypothese: Block 5 hat drei Import-Fälle nicht erkannt. Sein Prädikat
fragte „hängt ein Termin mit `notes LIKE 'Import aus Altdaten%'` dran?", und
das kann aus drei Gründen NEIN sagen — keine Termine mehr verknüpft, `notes`
später überschrieben, Termine hart gelöscht.

Gemessen wird das mit `docs/check-42er-zweiter-pfad.sql`
(Branch `einmal/verify-42er-zweiter-pfad`). Das Ergebnis gehört in **dieses**
Protokoll, sobald es vorliegt.

## Warum das Skript gelöscht ist

Einmal-Werkzeug nach der Regel in `CLAUDE.md`. Die Prädikate stehen oben
inline, die Messung ist also ohne git-Archäologie nachvollziehbar. Wer das
ganze Skript braucht:

```
git show a174f8c1:docs/check-42er-kassenbelege.sql
```
