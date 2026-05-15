# Erstberatungs-Kunden in Produktion — Read-only-Analyse

Stand: 15. Mai 2026 · Quelle: Produktions-Replica (read-only, `executeSql({ environment: "production" })`)

## Kurzfassung

In Prod liegen aktuell **15 aktive Kunden mit `status = 'erstberatung'` und `deleted_at IS NULL`**. **Alle 15 sind „Waisen"** — keiner hat einen Eintrag in `customers.converted_from_prospect_id`, und kein `prospects.converted_customer_id` zeigt auf einen dieser Kunden. Die bestehende Startup-Migration `server/startup/migrate-erstberatung-customers.ts` würde sie deshalb **nicht** umhängen (sie überspringt jeden Kandidaten ohne Prospect-Bezug).

Die 15 Datensätze hängen sehr lose im System: jeweils genau **1 Termin** (Typ `Erstberatung`) plus die zugehörigen `appointment_services`-Zeilen. **Keine** Rechnungen, **keine** hochgeladenen Kundendokumente, **keine** generierten Dokumente / Unterschriften, **keine** Budget-Allokationen, **keine** Budget-Transaktionen, **keine** Verschmelzungen (`merged_into_customer_id`), **keine** offenen Prospect-Verweise. Lediglich einer der 15 Kunden hat einen Audit-Log-Eintrag (Customer-Anlage).

Auswirkung auf die Statistiken ist klein in absoluten Zahlen, aber für die Conversion-Rate **stark verzerrend**: 2026 sinkt die gemessene Conversion von **24 → 12 Erstberatungen**, wodurch die Quote von **17 % auf 33 %** springt, sobald die 15 Waisen aus dem Kundenstamm verschwinden.

---

## 1. Bestand der Erstberatungs-Kunden

```sql
SELECT
  (SELECT COUNT(*) FROM customers c
     WHERE c.status='erstberatung' AND c.deleted_at IS NULL) AS total,
  (SELECT COUNT(*) FROM customers c
     WHERE c.status='erstberatung' AND c.deleted_at IS NULL
       AND (c.converted_from_prospect_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM prospects p
                         WHERE p.converted_customer_id = c.id
                           AND p.deleted_at IS NULL))) AS with_prospect,
  ... -- orphans = total - with_prospect
```

| Metrik | Wert |
|---|---|
| Gesamt `status='erstberatung'`, nicht soft-gelöscht | **15** |
| Davon mit Prospect-Verknüpfung (Migration würde sie abräumen) | **0** |
| Davon Waisen ohne jede Prospect-Verknüpfung | **15** |

Die Startup-Migration läuft also wirkungslos durch — `customerProspectPairs` bleibt leer, alle 15 landen im `WARNUNG`-Pfad.

## 2. Pro-Kunde-Aufschlüsselung (IDs anonymisiert auf interne Kunden-ID)

| ID  | Angelegt | Pflegegrad | Billing | Termine ges. | davon Erstberatung | andere | abgeschlossen | geplant | ältester | jüngster | Rechn. | Kunden-Dok. | Gen.-Dok. | Sig. | Budget-Alloc. | Budget-Tx | Audit |
|----:|---------:|-----------:|:--------|-------------:|-------------------:|-------:|--------------:|--------:|---------:|---------:|-------:|------------:|----------:|-----:|--------------:|----------:|------:|
| 120 | 2026-03-02 | 2 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-02-02 | 2026-02-02 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 121 | 2026-03-02 | 1 | gesetzl. | 1 | 1 | 0 | 0 | 1 | 2026-02-03 | 2026-02-03 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 122 | 2026-03-02 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-02-09 | 2026-02-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 123 | 2026-03-02 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-02-11 | 2026-02-11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 127 | 2026-03-03 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-06 | 2026-03-06 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 128 | 2026-03-03 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-09 | 2026-03-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 129 | 2026-03-05 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-06 | 2026-03-06 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 131 | 2026-03-05 | 2 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-02-09 | 2026-02-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 133 | 2026-03-06 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-09 | 2026-03-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 142 | 2026-03-10 | 5 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-02-20 | 2026-02-20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 143 | 2026-03-13 | 1 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-30 | 2026-03-30 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| 144 | 2026-03-13 | 1 | gesetzl. | 1 | 1 | 0 | 0 | 1 | 2026-03-25 | 2026-03-25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 145 | 2026-03-16 | 1 | gesetzl. | 1 | 1 | 0 | 0 | 1 | 2026-03-23 | 2026-03-23 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 147 | 2026-03-18 | 2 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-19 | 2026-03-19 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 154 | 2026-03-20 | 2 | gesetzl. | 1 | 1 | 0 | 1 | 0 | 2026-03-31 | 2026-03-31 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Summen:** 15 Termine (alle `appointment_type = 'Erstberatung'`, 15 zugehörige `appointment_services`-Zeilen), 12 `completed/documented`, 3 `scheduled`, älteste Buchung 2026-02-02, jüngste 2026-03-31. Alle Kunden sind im Frühjahr 2026 angelegt worden, alle Termine liegen im Bereich Feb–März 2026.

### Zeiteinträge (`employee_time_entries`)

Die Tabelle `employee_time_entries` hat in Prod **keine** Spalte `appointment_id` oder `customer_id` — Zeiteinträge sind im Schema nicht hart an Termine gebunden. Eine „Anzahl Zeiteinträge an Terminen dieser Kunden" lässt sich daher nicht über einen FK ermitteln; der ursprüngliche Auftragspunkt entfällt strukturell.

### Sonstige potenziell blockierende Verweise

```text
prospects.converted_customer_id → orphan:        0
customers.merged_into_customer_id → orphan:      0
appointments (incl. soft-deleted) auf orphans:  15
appointments mit signature_data:                 0
appointment_services-Zeilen:                    15
```

Es gibt also **keinen** harten FK-Konflikt, der einer Löschung im Weg stehen würde, außer `appointments` und `appointment_services` selbst.

## 3. Statistik-Effekt (inkl. vs. ohne Waisen)

### 3.1 Kundentrichter (`server/storage/statistics/customers.ts`, Feld `funnel.inConsultation`)

| Feld | Inkl. Waisen | Ohne Waisen |
|---|---:|---:|
| `prospect` | 0 | 0 |
| `inConsultation` | **15** | **0** |
| `active` | 122 | 122 |
| `inactive` | 11 | 11 |
| `terminated` | 0 | 0 |

→ Die Stufe „In Erstberatung" im Trichter ist heute **ausschließlich von diesen 15 Waisen** befüllt.

### 3.2 Conversion-Rate Erstberatung → Folgetermin (Jahr 2026, Replik der Query in `customers.ts`)

| Wert | Inkl. Waisen | Ohne Waisen |
|---|---:|---:|
| Erstberatungen (`eb_count`) | 24 | 12 |
| Conversions (`converted_count`) | 4 | 4 |
| Conversion-Rate | **17 %** | **33 %** |

Die Waisen tragen 12 Erstberatungs-Termine, aber **null** Conversions bei und drücken die Quote damit um die Hälfte. Das ist der größte einzelne statistische Hebel einer Bereinigung.

### 3.3 Performance-Report (`server/storage/statistics/performance.ts`)

Erstberatungs-Minuten aus den Waisen-Terminen (Jahr 2026, Status `completed`/`documented`):

| Monat | Termine | Minuten |
|---:|---:|---:|
| 2 | 5 | 315 |
| 3 | 7 | 405 |
| **Σ** | **12** | **720** |

Geschätzter Umsatz dieser 12 Termine über die Standard-Service-Preise: **0 €** — der Service „Erstberatung" hat in Prod `default_price_cents = 0` (auch keine kundenspezifischen Sonderpreise auf diesen Kunden). Eine Bereinigung verschiebt also `minutesByMonth.erstberatung` um 720 Min (≈ 12 h auf das Jahr) nach unten, beeinflusst aber **nicht** `revenuePerHour`, `profitability` oder den Gesamtumsatz.

## 4. Reproduzierbare SQL-Abschnitte

Alle Queries laufen read-only und sind im Notebook nachvollziehbar. Die wichtigsten:

```sql
-- (A) Bestand + Waisen
WITH erst AS (
  SELECT c.id, c.converted_from_prospect_id,
         (SELECT p.id FROM prospects p
            WHERE p.converted_customer_id = c.id AND p.deleted_at IS NULL LIMIT 1) AS prospect_via_link
  FROM customers c
  WHERE c.status='erstberatung' AND c.deleted_at IS NULL
)
SELECT
  (SELECT COUNT(*) FROM erst) AS total,
  (SELECT COUNT(*) FROM erst
     WHERE converted_from_prospect_id IS NOT NULL OR prospect_via_link IS NOT NULL) AS with_prospect,
  (SELECT COUNT(*) FROM erst
     WHERE converted_from_prospect_id IS NULL AND prospect_via_link IS NULL) AS orphans;

-- (B) Pro-Kunde-Aufschlüsselung
SELECT c.id, c.created_at::date, c.pflegegrad, c.billing_type, c.converted_from_prospect_id,
  (SELECT COUNT(*) FROM appointments a WHERE a.customer_id=c.id AND a.deleted_at IS NULL) AS appt_total,
  (SELECT COUNT(*) FROM appointments a WHERE a.customer_id=c.id AND a.deleted_at IS NULL
     AND a.appointment_type='Erstberatung') AS appt_eb,
  (SELECT COUNT(*) FROM appointments a WHERE a.customer_id=c.id AND a.deleted_at IS NULL
     AND a.appointment_type<>'Erstberatung') AS appt_other,
  (SELECT MIN(a.date)::date FROM appointments a WHERE a.customer_id=c.id AND a.deleted_at IS NULL) AS appt_min,
  (SELECT MAX(a.date)::date FROM appointments a WHERE a.customer_id=c.id AND a.deleted_at IS NULL) AS appt_max,
  (SELECT COUNT(*) FROM invoices i WHERE i.customer_id=c.id) AS invoices,
  (SELECT COUNT(*) FROM customer_documents cd WHERE cd.customer_id=c.id) AS customer_documents,
  (SELECT COUNT(*) FROM generated_documents gd WHERE gd.customer_id=c.id) AS generated_documents,
  (SELECT COUNT(*) FROM generated_documents gd WHERE gd.customer_id=c.id
     AND gd.customer_signature_data IS NOT NULL) AS signed_docs,
  (SELECT COUNT(*) FROM budget_allocations ba WHERE ba.customer_id=c.id AND ba.deleted_at IS NULL) AS budget_allocs,
  (SELECT COUNT(*) FROM budget_transactions bt WHERE bt.customer_id=c.id) AS budget_txns,
  (SELECT COUNT(*) FROM audit_log al WHERE al.entity_type='customer' AND al.entity_id=c.id) AS audit_entries
FROM customers c
WHERE c.status='erstberatung' AND c.deleted_at IS NULL
ORDER BY c.id;

-- (C) Conversion-Rate inkl./ohne Waisen (replica von customers.ts)
WITH orphans AS (
  SELECT c.id FROM customers c
  WHERE c.status='erstberatung' AND c.deleted_at IS NULL
    AND c.converted_from_prospect_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM prospects p
                      WHERE p.converted_customer_id=c.id AND p.deleted_at IS NULL)
),
first_eb AS (
  SELECT a.customer_id, MIN(a.date::date) AS first_eb
  FROM appointments a
  WHERE a.deleted_at IS NULL AND a.appointment_type='Erstberatung'
    AND a.status IN ('completed','documented') AND a.customer_id IS NOT NULL
    AND EXTRACT(YEAR FROM a.date::date)=2026
  GROUP BY a.customer_id
),
first_regular AS (
  SELECT a.customer_id, MIN(a.date::date) AS first_reg
  FROM appointments a
  JOIN first_eb fe ON fe.customer_id=a.customer_id
  WHERE a.deleted_at IS NULL AND a.appointment_type!='Erstberatung'
    AND a.status IN ('completed','documented','scheduled')
    AND a.date::date >= fe.first_eb
    AND a.date::date <= fe.first_eb + INTERVAL '90 days'
  GROUP BY a.customer_id
)
SELECT
  (SELECT COUNT(*) FROM first_eb) AS eb_total,
  (SELECT COUNT(*) FROM first_regular) AS conv_total,
  (SELECT COUNT(*) FROM first_eb WHERE customer_id NOT IN (SELECT id FROM orphans)) AS eb_without_orphans,
  (SELECT COUNT(*) FROM first_regular WHERE customer_id NOT IN (SELECT id FROM orphans)) AS conv_without_orphans;

-- (D) Performance-Minuten der Waisen-Erstberatungen pro Monat (replica von performance.ts).
-- Hinweis: Hier wird derselbe strikte Waisen-Filter wie in (A)/(C) benutzt. Da
-- with_prospect = 0 ist, liefert ein breiterer Filter (alle status='erstberatung')
-- in diesem Snapshot identische Zahlen.
WITH orphans AS (
  SELECT c.id FROM customers c
  WHERE c.status='erstberatung' AND c.deleted_at IS NULL
    AND c.converted_from_prospect_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM prospects p
                      WHERE p.converted_customer_id=c.id AND p.deleted_at IS NULL)
)
SELECT EXTRACT(MONTH FROM a.date::date)::int AS month,
       COUNT(*)::int AS appts,
       COALESCE(SUM(a.duration_promised),0)::int AS minutes
FROM appointments a
WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
  AND a.appointment_type='Erstberatung'
  AND a.customer_id IN (SELECT id FROM orphans)
  AND EXTRACT(YEAR FROM a.date::date)=2026
GROUP BY 1 ORDER BY 1;
```

## 5. Beobachtungen

1. Die Waisen entstehen offensichtlich aus dem alten Kundenanlage-Flow, in dem ein Lead direkt als Kunde mit `status='erstberatung'` angelegt wurde, ohne einen zugehörigen `prospects`-Datensatz zu erzeugen — alle 15 stammen aus einem engen Zeitfenster (März 2026).
2. Es gibt keinerlei finanziell oder rechtlich relevante Folge-Daten (keine Rechnungen, keine unterschriebenen Dokumente, keine Budget-Bewegungen), d. h. eine Bereinigung wäre auch GoBD-seitig unkritisch — bis auf die 12 abgeschlossenen Erstberatungs-Termine, die als geleisteter Vorgang dokumentiert bleiben sollten.
3. Der einzige Audit-Eintrag (Kunde 143) ist eine Customer-Anlage; nichts Veränderungs-Historisches hängt daran.
4. Das Hauptproblem ist nicht das Datenvolumen, sondern die **Statistik-Verzerrung**: 15 Waisen blockieren die Trichterstufe „In Erstberatung" dauerhaft und halbieren die ausgewiesene Conversion-Quote 2026.

## 6. Empfehlung (3–5 Sätze, keine Implementierung)

Die sauberste Lösung ist, die bestehende Startup-Migration so zu erweitern, dass sie für jeden Waisen automatisch einen synthetischen `prospects`-Datensatz aus den Kundenstammdaten anlegt (Status `erstberatung_durchgeführt`) und den Termin daran umhängt — die Migration kann den Rest unverändert über ihren bewährten Pfad erledigen, und kein Termin geht verloren. Alternativ und mit deutlich geringerem Aufwand können die 15 Kunden samt ihrer 15 Termine (alle Typ `Erstberatung`, kein Folgegeschäft, keine Rechnungen, keine Unterschriften) per einmaligem Skript hart gelöscht werden; das ist die radikalste, aber konsistenteste Variante. In beiden Fällen sollte anschließend geprüft werden, ob der Kundenanlage-Flow heute noch Pfade kennt, die einen Kunden mit `status='erstberatung'` ohne `convertedFromProspectId` erzeugen — sonst läuft die Waisen-Liste wieder voll. Eine Schema-seitige Entfernung des Status `erstberatung` aus `customers` ist erst danach sinnvoll und gehört nicht in diese Iteration.
