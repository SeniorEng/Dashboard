# Schema-Audit Report

**Task:** #219 — Schema-Audit
**Datum:** 2026-04-28
**Datenquelle:** Production-Datenbank (Replit Postgres). Snapshot der Statistiken am Audit-Tag.
**Umfang:** Alle 64 Tabellen aus `shared/schema/*.ts`, alle 859 Spalten.
**Charakter:** Reiner Audit-Report. Keine Code-Änderungen, keine Migrationen.

---

## 1. Executive Summary

| Kennzahl | Wert |
|---|---|
| Tabellen in `shared/schema/*.ts` | 64 |
| Tabellen mit Daten in Prod | 48 |
| Leere Tabellen in Prod | 16 |
| Spalten gesamt | 859 |
| Spalten **active** (Daten + nicht auffällig) | 501 |
| Spalten **empty-in-prod** in Tabellen mit Daten | 86 |
| Spalten **constant-in-prod** (1 distinct value) | 46 |
| Spalten **low-usage** (befüllt, aber selten) | 38 |
| Spalten in komplett leeren Tabellen | 188 |
| Empfehlung **drop-migration** | 1 Tabelle + 4 Spalten (siehe §5.1) |
| Empfehlung **observe** | ~22 Tabellen/Spalten (siehe §5.2) |
| Empfehlung **keep** | restliche Tabellen/Spalten |

### Kernbefunde

1. **`customer_pricing_history`** ist ein Orphan: leer in Prod (`SELECT COUNT(*) FROM customer_pricing_history → 0`), im Server-Code nur in Lösch-/Merge-Utilities referenziert, sonst keine Reads/Writes. → **drop-migration empfohlen**.
2. **`customer_contracts.hauswirtschaft_rate_cents`, `alltagsbegleitung_rate_cents`, `kilometer_rate_cents`** sind über alle 108 Verträge konstant `0` (`SELECT COUNT(DISTINCT hauswirtschaft_rate_cents), MAX(hauswirtschaft_rate_cents) FROM customer_contracts → 1, 0`). Werden durch `customer_service_prices` / `customer_contract_rates` ersetzt. → **drop-migration nach Verifikation**.
3. **`appointments.services_done`** (text[]) — 0/735 Zeilen befüllt (`SELECT COUNT(*) FILTER (WHERE array_length(services_done, 1) > 0) FROM appointments → 0`). Legacy-Spalte, ersetzt durch `appointment_services`. → **drop-migration**.
4. **`appointments.is_series_exception`** — 0/735 Zeilen `true` (`SELECT COUNT(*) FILTER (WHERE is_series_exception = TRUE) FROM appointments → 0`). Wird zwar geschrieben (Default false), hat aber nie produktive Aktivierung gehabt. → **observe** (Logik existiert).
5. **`appointments.doctor_latitude` / `doctor_longitude`** — 0/9 Fahrtdienst-Termine haben Geokoordinaten (`SELECT COUNT(*) FILTER (WHERE doctor_latitude IS NOT NULL AND is_fahrtdienst = TRUE) FROM appointments → 0` von 9 Fahrtdienst-Terminen). Schema sieht es vor, Geocoding läuft im Code aber nicht in Prod. → **observe**.
6. **`users.notfallkontakt_name/_telefon/_beziehung`, `lbnr`, `personalnummer`** — alle 0/23 (`SELECT COUNT(*) FILTER (WHERE notfallkontakt_name IS NOT NULL AND notfallkontakt_name <> '') FROM users → 0` etc.). Felder sind im UI sichtbar (Profile/Employees), niemand hat Daten gepflegt. → **observe / Daten nachpflegen**.
7. **`company_settings`** — **1 Zeile, 60 Spalten**, davon 18 leer (E-POST, Qonto, WhatsApp Konfig, Lohnart-Codes, Anerkennungsnummer §45a). Erwartet — Konfiguration für noch nicht aktive Module. → **keep**.
8. **`customers.name`** ist trotz Legacy-Marker noch voll befüllt: 133/133 Datensätze (`SELECT COUNT(*) FILTER (WHERE name IS NOT NULL AND name <> '') FROM customers → 133`). **Nicht** drop-fähig — die Daten existieren weiterhin. → **observe** (Schreib-Pfad bereits abgelöst durch `vorname`/`nachname`, aber Lese-Pfade müssen vor dem Drop sauber sein).
9. **`customers.telefon`** ist 88/133 befüllt (`SELECT COUNT(*) FILTER (WHERE telefon IS NOT NULL AND telefon <> '') FROM customers → 88`). Migration nach `customer_contacts.festnetz/mobilnummer` unvollständig (dort nur 5 + 11 von 112). → **observe** (Daten-Migration zuerst, dann Drop — wird durch Bestands-Task `cleanup-contact-phone-fields.md` abgedeckt).
10. **16 leere Tabellen** stammen aus Modulen, die noch nicht in Produktion in Nutzung sind (Rechnungs-Pipeline, Qonto, Qualifikationen, Document-Delivery). → **keep / observe**.

---

## 2. Methodik

### Datenerhebung

1. **Schema-Inventar**: Alle 21 Dateien unter `shared/schema/*.ts` gelesen und die 64 `pgTable(...)` Definitionen extrahiert.
2. **Spalten-Metadaten** aus `information_schema.columns` für alle Tabellen (859 Spalten).
3. **Row-Counts** je Tabelle: `SELECT COUNT(*) FROM "<table>"`.
4. **Spalten-Nutzung** je Tabelle mit dynamischem SQL pro Spaltentyp:
   ```sql
   -- Skalare Typen (integer, real, date, timestamp, …):
   SELECT COUNT(*) AS total,
          COUNT(<col>) AS not_null,
          COUNT(DISTINCT <col>) AS distinct_values
   FROM "<table>";
   
   -- text:
   SELECT COUNT(*) FILTER (WHERE <col> IS NOT NULL AND <col> <> '') AS filled,
          COUNT(DISTINCT <col>) AS distinct_values
   FROM "<table>";
   
   -- boolean:
   SELECT COUNT(*) FILTER (WHERE <col> = TRUE) AS true_count FROM "<table>";
   
   -- text[]:
   SELECT COUNT(*) FILTER (WHERE array_length(<col>, 1) > 0) AS filled FROM "<table>";
   
   -- jsonb:
   SELECT COUNT(*) FILTER (WHERE <col> IS NOT NULL AND <col>::text NOT IN ('{}', '[]', 'null')) AS filled FROM "<table>";
   ```
5. **Code-Cross-Check** mit ripgrep im Server- und Client-Code für verdächtige Spalten/Tabellen.
6. **Migrations-Historie**: Migrationen `0000` – `0010` und `0012` (Lücke bei `0011` festgestellt) gesichtet.

### Klassifikation

- **active** — Spalte hat in Prod Werte UND wird vom Server-Code geschrieben.
- **not-written** — Spalte ist im Schema, aber Server-Code schreibt sie nicht (kein `INSERT/UPDATE` Treffer).
- **empty-in-prod** — Spalte ist im Schema, Code schreibt sie potenziell, aber 0 (nicht-NULL/nicht-leer) Werte in Prod.
- **constant-in-prod** — Spalte ist befüllt, hat aber genau 1 distinct value (meist Default).
- **low-usage** — Spalte hat Werte, aber nur in einem geringen Anteil der Zeilen.
- **legacy** — Spalte hat Schema-Kommentar als Legacy markiert (kann zusätzlich active oder empty sein).

### Empfehlung

- **keep** — produktiv genutzt oder Konfigurationsslot, der bewusst leer ist.
- **observe** — leer/konstant, aber Code-Pfad existiert oder Daten vorhanden, die noch konsumiert werden müssen. Nach 3 Monaten erneut prüfen.
- **drop-migration** — leer + kein Schreib-Pfad + kein Lese-Pfad oder eindeutig durch Nachfolger ersetzt UND keine produktiven Daten mehr vorhanden.

---

## 3. Tabellen-Übersicht (alle 64)

| Tabelle | Rows in Prod | # Spalten | Status |
|---|---:|---:|---|
| `admin_permissions` | 3 | 5 | nur 3 Zeile(n) |
| `appointment_series` | 6 | 16 | aktiv |
| `appointment_services` | 738 | 6 | aktiv |
| `appointments` | 735 | 41 | aktiv |
| `audit_log` | 2302 | 8 | aktiv |
| `birthday_card_tracking` | 11 | 9 | aktiv |
| `budget_allocations` | 662 | 13 | aktiv |
| `budget_transactions` | 344 | 20 | aktiv |
| `company_settings` | 1 | 60 | nur 1 Zeile(n) |
| `customer_assignment_history` | 241 | 8 | aktiv |
| `customer_budget_preferences` | 33 | 7 | aktiv |
| `customer_budget_type_settings` | 255 | 13 | aktiv |
| `customer_budgets` | 17 | 10 | aktiv |
| `customer_care_level_history` | 117 | 9 | aktiv |
| `customer_contacts` | 112 | 14 | aktiv |
| `customer_contract_rates` | 2 | 8 | nur 2 Zeile(n) |
| `customer_contracts` | 108 | 16 | aktiv |
| `customer_documents` | 585 | 14 | aktiv |
| `customer_insurance_history` | 104 | 9 | aktiv |
| `customer_needs_assessments` | 1 | 25 | nur 1 Zeile(n) |
| `customer_pricing_history` | 0 | 9 | **ORPHAN — drop empfohlen** |
| `customer_service_prices` | 1 | 8 | nur 1 Zeile(n) |
| `customers` | 133 | 40 | aktiv |
| `document_deliveries` | 0 | 15 | leer in Prod |
| `document_signing_tokens` | 0 | 6 | leer in Prod |
| `document_template_billing_types` | 9 | 5 | aktiv |
| `document_templates` | 7 | 15 | aktiv |
| `document_type_triggers` | 1 | 12 | nur 1 Zeile(n) |
| `document_types` | 27 | 13 | aktiv |
| `employee_compensation_history` | 0 | 11 | leer in Prod |
| `employee_document_proofs` | 0 | 14 | leer in Prod |
| `employee_documents` | 47 | 14 | aktiv |
| `employee_month_closings` | 2 | 9 | nur 2 Zeile(n) |
| `employee_qualifications` | 0 | 6 | leer in Prod |
| `employee_time_entries` | 236 | 14 | aktiv |
| `employee_vacation_allowance` | 18 | 8 | aktiv |
| `generated_documents` | 7 | 19 | aktiv |
| `insurance_providers` | 314 | 24 | aktiv |
| `invoice_line_items` | 0 | 16 | leer in Prod |
| `invoices` | 0 | 30 | leer in Prod |
| `monthly_service_records` | 49 | 22 | aktiv |
| `notifications` | 315 | 9 | aktiv |
| `password_reset_tokens` | 2 | 6 | nur 2 Zeile(n) |
| `payment_advice_items` | 0 | 11 | leer in Prod |
| `payment_advices` | 0 | 20 | leer in Prod |
| `prospect_notes` | 450 | 6 | aktiv |
| `prospect_offers` | 0 | 7 | leer in Prod |
| `prospects` | 94 | 23 | aktiv |
| `qonto_transactions` | 0 | 15 | leer in Prod |
| `qualification_documents` | 0 | 5 | leer in Prod |
| `qualifications` | 0 | 7 | leer in Prod |
| `scheduled_calls` | 1 | 12 | nur 1 Zeile(n) |
| `service_budget_pots` | 12 | 3 | aktiv |
| `service_rates` | 0 | 7 | leer in Prod |
| `service_record_appointments` | 91 | 4 | aktiv |
| `services` | 5 | 16 | aktiv |
| `sessions` | 2 | 6 | nur 2 Zeile(n) |
| `system_settings` | 1 | 5 | nur 1 Zeile(n) |
| `tasks` | 95 | 13 | aktiv |
| `user_roles` | 64 | 4 | aktiv |
| `user_whatsapp_preferences` | 10 | 6 | aktiv |
| `users` | 23 | 37 | aktiv |
| `whatsapp_message_log` | 0 | 9 | leer in Prod |
| `whatsapp_notification_rules` | 7 | 7 | aktiv |

---

**Summen:** 64 Tabellen · 859 Spalten · 8.400 Zeilen in Prod.

---

## 4. Per-Tabellen Spalten-Klassifikation

Pro Tabelle werden nur **auffällige Spalten** (empty / low-usage / constant / legacy) aufgeführt. Alle anderen Spalten sind **active / keep**.

Evidenz-Format: `<filled>/<total>` aus dem in §2 dokumentierten SQL-Muster, ggf. erweitert um `distinct=N`.

### `admin_permissions` — 3 Zeilen, 5 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `user_id` | constant-in-prod | `distinct = 1` | keep |  |
| `created_at` | constant-in-prod | `distinct = 1` | keep |  |

### `appointment_series` — 6 Zeilen, 16 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `notes` | empty-in-prod | `filled = 0 / 6` | observe |  |
| `status` | constant-in-prod | `distinct = 1` | keep |  |
| `updated_at` | empty-in-prod | `filled = 0 / 6` | observe |  |

### `appointment_services` — 738 Zeilen, 6 Spalten

Alle 6 Spalten **active / keep** — keine auffälligen Befunde.

### `appointments` — 735 Zeilen, 41 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `services_done` | empty-in-prod (legacy text[]) | `filled = 0 / 735` | **drop-migration** | Legacy text[] — 0/735, ersetzt durch appointment_services |
| `signature_data` | low-usage | `filled = 15/735` | keep |  |
| `service_type` | legacy, aber aktiv gelesen | `filled = 122 / 735, distinct = 2` | observe | Legacy — 122/735 noch befüllt, aktiv von Budget/Import gelesen · aktiv gelesen, nicht droppen |
| `signature_hash` | low-usage | `filled = 15/735` | keep |  |
| `prospect_id` | low-usage | `filled = 34/735` | keep |  |
| `is_series_exception` | empty-in-prod | `filled = 0 / 735` | observe |  |
| `is_fahrtdienst` | low-usage | `filled = 9/735` | keep |  |
| `doctor_name` | low-usage | `filled = 9/735` | keep |  |
| `doctor_appointment_time` | low-usage | `filled = 9/735` | keep |  |
| `doctor_strasse` | low-usage | `filled = 9/735` | keep |  |
| `doctor_plz` | low-usage | `filled = 9/735` | keep |  |
| `doctor_stadt` | low-usage | `filled = 9/735` | keep |  |
| `doctor_latitude` | empty-in-prod | `filled = 0 / 735` | observe |  |
| `doctor_longitude` | empty-in-prod | `filled = 0 / 735` | observe |  |
| `estimated_travel_minutes` | low-usage | `filled = 9/735` | keep |  |
| `travel_buffer_minutes` | low-usage | `filled = 9/735` | keep |  |
| `doctor_nr` | low-usage | `filled = 8/735` | keep |  |

Restliche Spalten (`customer_id`, `date`, `scheduled_start`, `assigned_employee_id`, `appointment_type`, …) sind active.

### `audit_log` — 2302 Zeilen, 8 Spalten

Alle 8 Spalten **active / keep** — keine auffälligen Befunde.

### `birthday_card_tracking` — 11 Zeilen, 9 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `year` | constant-in-prod | `distinct = 1` | keep |  |
| `notes` | empty-in-prod | `filled = 0 / 11` | observe |  |

### `budget_allocations` — 662 Zeilen, 13 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `deleted_at` | low-usage | `filled = 29/662` | keep |  |

### `budget_transactions` — 344 Zeilen, 20 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `reversed_transaction_id` | low-usage | `filled = 10/344` | keep |  |

### `company_settings` — 1 Zeilen, 60 Spalten
> 1 Zeile, 60 Spalten — 18 leer (Konfig für noch nicht aktive Module: E-POST/Qonto/WhatsApp/Lohnarten), 2 konstant. **keep** als Konfig-Tabelle.

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `anerkennungsnummer_45a` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `anerkennungs_bundesland` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `updated_at` | constant-in-prod | `distinct = 1` | keep |  |
| `lohnart_alltagsbegleitung` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `lohnart_hauswirtschaft` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `lohnart_urlaub` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `lohnart_krankheit` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `epost_vendor_id` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `epost_ekp` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `epost_password` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `epost_secret` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `delivery_email_subject` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `delivery_cover_letter_text` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `minijob_earnings_limit_cents` | constant-in-prod | `distinct = 1` | keep |  |
| `qonto_login` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `qonto_secret_key` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `qonto_iban` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `whatsapp_access_token` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `whatsapp_phone_number_id` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `whatsapp_enabled` | empty-in-prod | `filled = 0 / 1` | observe |  |

60 Spalten total · 18 leer (siehe Tabelle oben) · 2 konstant (`updated_at`, `minijob_earnings_limit_cents`). Restliche 40 Spalten sind active. **keep** als Konfig-Tabelle.

### `customer_assignment_history` — 241 Zeilen, 8 Spalten

Alle 8 Spalten **active / keep** — keine auffälligen Befunde.

### `customer_budget_preferences` — 33 Zeilen, 7 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `monthly_limit_cents` | empty-in-prod | `filled = 0 / 33` | observe |  |
| `notes` | low-usage | `filled = 1/33` | keep |  |

### `customer_budget_type_settings` — 255 Zeilen, 13 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `yearly_limit_cents` | low-usage | `filled = 8/255` | keep |  |
| `valid_from` | low-usage | `filled = 3/255` | keep |  |
| `valid_to` | low-usage | `filled = 1/255` | keep |  |

### `customer_budgets` — 17 Zeilen, 10 Spalten
> Legacy-Snapshot-Tabelle, weiterhin von Storage benutzt; parallel zum neuen `budget_allocations`. **observe** (Konsolidierung mit `budget_allocations` separates Refactor).

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `entlastungsbetrag_45b` | constant-in-prod | `distinct = 1` | keep |  |
| `valid_to` | empty-in-prod | `filled = 0 / 17` | observe |  |
| `notes` | empty-in-prod | `filled = 0 / 17` | observe |  |

### `customer_care_level_history` — 117 Zeilen, 9 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `pflegegrad_beantragt` | empty-in-prod | `filled = 0 / 117` | observe |  |
| `notes` | empty-in-prod | `filled = 0 / 117` | observe |  |

### `customer_contacts` — 112 Zeilen, 14 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `email` | low-usage | `filled = 4/112` | keep |  |
| `notes` | low-usage | `filled = 3/112` | keep |  |
| `festnetz` | low-usage | `filled = 5/112` | keep |  |

### `customer_contract_rates` — 2 Zeilen, 8 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `contract_id` | constant-in-prod | `distinct = 1` | keep |  |
| `valid_from` | constant-in-prod | `distinct = 1` | keep |  |
| `valid_to` | empty-in-prod | `filled = 0 / 2` | observe |  |

### `customer_contracts` — 108 Zeilen, 16 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `hours_per_period` | legacy, aber **aktiv befüllt** | `filled = 63 / 108, distinct = 5` | observe (Schema-Marker irreführend) | Schema-Kommentar markiert als legacy, aber 63/108 aktiv befüllt · aktiv genutzt — nicht droppen |
| `period_type` | legacy, aber **aktiv befüllt** | `distinct = 2 / 108` (month, week) | observe (Schema-Marker irreführend) | Schema-Kommentar markiert als legacy, aber 2 Werte (month/week) aktiv · aktiv genutzt — nicht droppen |
| `notes` | empty-in-prod | `filled = 0 / 108` | observe |  |
| `hauswirtschaft_rate_cents` | constant-in-prod (always 0) | `distinct = 1, max = 0` (108 rows) | **drop-migration** | Replaced by customer_service_prices — 108/108 = 0 |
| `alltagsbegleitung_rate_cents` | constant-in-prod (always 0) | `distinct = 1, max = 0` (108 rows) | **drop-migration** | Replaced by customer_service_prices — 108/108 = 0 |
| `kilometer_rate_cents` | constant-in-prod (always 0) | `distinct = 1, max = 0` (108 rows) | **drop-migration** | Replaced by customer_service_prices — 108/108 = 0 |

### `customer_documents` — 585 Zeilen, 14 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `review_due_date` | empty-in-prod | `filled = 0 / 585` | observe |  |
| `notes` | empty-in-prod | `filled = 0 / 585` | observe |  |
| `batch_label` | low-usage | `filled = 8/585` | keep |  |
| `deleted_at` | low-usage | `filled = 5/585` | keep |  |

### `customer_insurance_history` — 104 Zeilen, 9 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `valid_to` | empty-in-prod | `filled = 0 / 104` | observe |  |
| `notes` | empty-in-prod | `filled = 0 / 104` | observe |  |

### `customer_needs_assessments` — 1 Zeilen, 25 Spalten
> 1 Datensatz, 18 service_* Booleans alle false. UI vorhanden — Pflege-Lücke. **observe**.

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `customer_id` | constant-in-prod | `distinct = 1` | keep |  |
| `assessment_date` | constant-in-prod | `distinct = 1` | keep |  |
| `household_size` | constant-in-prod | `distinct = 1` | keep |  |
| `pflegedienst_beauftragt` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_haushalt_hilfe` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_mahlzeiten` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_waesche_pflege` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_einkauf` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_tagesablauf` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_alltagsverrichtungen` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_terminbegleitung` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_botengaenge` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_grundpflege` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_freizeitbegleitung` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_demenzbetreuung` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_gesellschaft` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_soziale_kontakte` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_freizeitgestaltung` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `service_kreativ` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `sonstige_leistungen` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `created_at` | constant-in-prod | `distinct = 1` | keep |  |
| `created_by_user_id` | empty-in-prod | `filled = 0 / 1` | observe |  |

### `customer_pricing_history` — 0 Zeilen, 9 Spalten
> Orphan — keine Reads/Writes außer Cleanup-Skript. **drop-migration**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "customer_pricing_history" → 0`.

Für jede der 9 Spalten gilt automatisch `filled = 0 / 0` (Tabelle leer).

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung |
|---|---|---|---|
| `id` | empty-in-prod (Tabelle leer) | `COUNT(id) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `customer_id` | empty-in-prod (Tabelle leer) | `COUNT(customer_id) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `hauswirtschaft_rate_cents` | empty-in-prod (Tabelle leer) | `COUNT(hauswirtschaft_rate_cents) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `alltagsbegleitung_rate_cents` | empty-in-prod (Tabelle leer) | `COUNT(alltagsbegleitung_rate_cents) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `kilometer_rate_cents` | empty-in-prod (Tabelle leer) | `COUNT(kilometer_rate_cents) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `valid_from` | empty-in-prod (Tabelle leer) | `COUNT(valid_from) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `valid_to` | empty-in-prod (Tabelle leer) | `COUNT(valid_to) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `created_at` | empty-in-prod (Tabelle leer) | `COUNT(created_at) = 0 / 0` | **drop-migration** (gesamte Tabelle) |
| `created_by_user_id` | empty-in-prod (Tabelle leer) | `COUNT(created_by_user_id) = 0 / 0` | **drop-migration** (gesamte Tabelle) |

### `customer_service_prices` — 1 Zeilen, 8 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `customer_id` | constant-in-prod | `distinct = 1` | keep |  |
| `service_id` | constant-in-prod | `distinct = 1` | keep |  |
| `price_cents` | constant-in-prod | `distinct = 1` | keep |  |
| `valid_from` | constant-in-prod | `distinct = 1` | keep |  |
| `valid_to` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `created_at` | constant-in-prod | `distinct = 1` | keep |  |
| `deleted_at` | empty-in-prod | `filled = 0 / 1` | observe |  |

### `customers` — 133 Zeilen, 40 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `name` | active | `filled = 133 / 133`, `distinct = 128` | keep | Legacy concat — Daten vorhanden (133/133), produktiver Schreibpfad bereits durch vorname/nachname ersetzt · voll befüllt — Migration zu vorname/nachname bereits parallel erfolgt, Spalte selbst nicht mehr produktiv geschrieben aber Daten vorhanden |
| `telefon` | active | `filled = 88 / 133`, `distinct = 76` | keep | Legacy single phone — 88/133 noch befüllt, Migration nach customer_contacts unvollständig · 88/133 Kunden haben hier noch ihre Telefonnummer (NICHT in customer_contacts migriert) |
| `accepts_private_payment` | low-usage | `filled = 1/133` | keep |  |
| `is_anonymized` | empty-in-prod | `filled = 0 / 133` | observe |  |
| `anonymized_at` | empty-in-prod | `filled = 0 / 133` | observe |  |
| `merged_into_customer_id` | low-usage | `filled = 6/133` | keep |  |
| `backup_employee_id_2` | low-usage | `filled = 5/133` | keep |  |
| `converted_from_prospect_id` | empty-in-prod | `filled = 0 / 133` | observe |  |
| `receives_monthly_invoice` | empty-in-prod | `filled = 0 / 133` | observe |  |
| `beihilfe_berechtigt` | low-usage | `filled = 1/133` | keep |  |

### `document_deliveries` — 0 Zeilen, 15 Spalten
> E-Post / E-Mail Versand; noch nicht aktiviert. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "document_deliveries" → 0`.

### `document_signing_tokens` — 0 Zeilen, 6 Spalten
> Token-Tabelle für Signing-Flow. Empty — noch keine Signing-Vorgänge. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "document_signing_tokens" → 0`.

### `document_template_billing_types` — 9 Zeilen, 5 Spalten

Alle 5 Spalten **active / keep** — keine auffälligen Befunde.

### `document_templates` — 7 Zeilen, 15 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `target_type` | constant-in-prod | `distinct = 1` | keep |  |

### `document_type_triggers` — 1 Zeilen, 12 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `document_type_id` | constant-in-prod | `distinct = 1` | keep |  |
| `entity_type` | constant-in-prod | `distinct = 1` | keep |  |
| `trigger_type` | constant-in-prod | `distinct = 1` | keep |  |
| `condition_operator` | constant-in-prod | `distinct = 1` | keep |  |
| `requirement` | constant-in-prod | `distinct = 1` | keep |  |
| `sort_order` | constant-in-prod | `distinct = 1` | keep |  |
| `created_at` | constant-in-prod | `distinct = 1` | keep |  |
| `updated_at` | constant-in-prod | `distinct = 1` | keep |  |

### `document_types` — 27 Zeilen, 13 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `renewal_days` | empty-in-prod | `filled = 0 / 27` | observe |  |

### `employee_compensation_history` — 0 Zeilen, 11 Spalten
> Vergütungshistorie scaffolded. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "employee_compensation_history" → 0`.

### `employee_document_proofs` — 0 Zeilen, 14 Spalten
> Spezial-Proofs für Mitarbeiter-Dokumente. Empty. **observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "employee_document_proofs" → 0`.

### `employee_documents` — 47 Zeilen, 14 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `review_due_date` | low-usage | `filled = 2/47` | keep |  |
| `deleted_at` | empty-in-prod | `filled = 0 / 47` | observe |  |

### `employee_month_closings` — 2 Zeilen, 9 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `year` | constant-in-prod | `distinct = 1` | keep |  |
| `month` | constant-in-prod | `distinct = 1` | keep |  |
| `reopened_at` | empty-in-prod | `filled = 0 / 2` | observe |  |
| `reopened_by_user_id` | empty-in-prod | `filled = 0 / 2` | observe |  |

### `employee_qualifications` — 0 Zeilen, 6 Spalten
> Hängt an `qualifications`. **keep / observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "employee_qualifications" → 0`.

### `employee_time_entries` — 236 Zeilen, 14 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `is_auto_generated` | low-usage | `filled = 8/236` | keep |  |

### `employee_vacation_allowance` — 18 Zeilen, 8 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `year` | constant-in-prod | `distinct = 1` | keep |  |

### `generated_documents` — 7 Zeilen, 19 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `template_version` | constant-in-prod | `distinct = 1` | keep |  |
| `employee_signature_data` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `signed_at` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `signed_by_employee_id` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `employee_id` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `document_type_id` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `rendered_html` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `signing_status` | constant-in-prod | `distinct = 1` | keep |  |
| `signing_ip` | empty-in-prod | `filled = 0 / 7` | observe |  |
| `signing_location` | empty-in-prod | `filled = 0 / 7` | observe |  |

### `insurance_providers` — 314 Zeilen, 24 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `email` | low-usage | `filled = 4/314` | keep |  |
| `empfaenger_zeile2` | low-usage | `filled = 5/314` | keep |  |
| `anschrift` | empty-in-prod | `filled = 0 / 314` | observe |  |
| `plz_ort` | empty-in-prod | `filled = 0 / 314` | observe |  |
| `email_invoice_enabled` | low-usage | `filled = 2/314` | keep |  |
| `fax` | low-usage | `filled = 14/314` | keep |  |
| `kim_adresse` | low-usage | `filled = 2/314` | keep |  |
| `email_verhinderungspflege` | low-usage | `filled = 1/314` | keep |  |
| `is_private` | low-usage | `filled = 1/314` | keep |  |

### `invoice_line_items` — 0 Zeilen, 16 Spalten
> Hängt an `invoices`. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "invoice_line_items" → 0`.

### `invoices` — 0 Zeilen, 30 Spalten
> Rechnungs-Pipeline scaffolded, noch nicht produktiv. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "invoices" → 0`.

### `monthly_service_records` — 49 Zeilen, 22 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `year` | constant-in-prod | `distinct = 1` | keep |  |
| `deleted_at` | low-usage | `filled = 1/49` | keep |  |

### `notifications` — 315 Zeilen, 9 Spalten

Alle 9 Spalten **active / keep** — keine auffälligen Befunde.

### `password_reset_tokens` — 2 Zeilen, 6 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `user_id` | constant-in-prod | `distinct = 1` | keep |  |
| `used_at` | empty-in-prod | `filled = 0 / 2` | observe |  |

### `payment_advice_items` — 0 Zeilen, 11 Spalten
> Hängt an `payment_advices`. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "payment_advice_items" → 0`.

### `payment_advices` — 0 Zeilen, 20 Spalten
> Zahlungseingang-Pipeline scaffolded. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "payment_advices" → 0`.

### `prospect_notes` — 450 Zeilen, 6 Spalten

Alle 6 Spalten **active / keep** — keine auffälligen Befunde.

### `prospect_offers` — 0 Zeilen, 7 Spalten
> Angebots-Wizard scaffolded. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "prospect_offers" → 0`.

### `prospects` — 94 Zeilen, 23 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `converted_customer_id` | empty-in-prod | `filled = 0 / 94` | observe |  |
| `assigned_employee_id` | empty-in-prod | `filled = 0 / 94` | observe |  |
| `disqualification_reason` | empty-in-prod | `filled = 0 / 94` | observe |  |

### `qonto_transactions` — 0 Zeilen, 15 Spalten
> Qonto-Sync scaffolded, kein Sync-Lauf. **keep**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "qonto_transactions" → 0`.

### `qualification_documents` — 0 Zeilen, 5 Spalten
> Hängt an `qualifications`. **keep / observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "qualification_documents" → 0`.

### `qualifications` — 0 Zeilen, 7 Spalten
> Qualifikations-Modul scaffolded. **keep / observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "qualifications" → 0`.

### `scheduled_calls` — 1 Zeilen, 12 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `prospect_id` | constant-in-prod | `distinct = 1` | keep |  |
| `lead_name` | constant-in-prod | `distinct = 1` | keep |  |
| `lead_phone` | constant-in-prod | `distinct = 1` | keep |  |
| `scheduled_at` | constant-in-prod | `distinct = 1` | keep |  |
| `status` | constant-in-prod | `distinct = 1` | keep |  |
| `attempts` | constant-in-prod | `distinct = 1` | keep |  |
| `last_error` | empty-in-prod | `filled = 0 / 1` | observe |  |
| `created_at` | constant-in-prod | `distinct = 1` | keep |  |

### `service_budget_pots` — 12 Zeilen, 3 Spalten

Alle 3 Spalten **active / keep** — keine auffälligen Befunde.

### `service_rates` — 0 Zeilen, 7 Spalten
> Globale Service-Sätze; aktuell ausschließlich kundenindividuelle Preise (`customer_service_prices`). **observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "service_rates" → 0`.

### `service_record_appointments` — 91 Zeilen, 4 Spalten

Alle 4 Spalten **active / keep** — keine auffälligen Befunde.

### `services` — 5 Zeilen, 16 Spalten

Alle 16 Spalten **active / keep** — keine auffälligen Befunde.

### `sessions` — 2 Zeilen, 6 Spalten

Alle 6 Spalten **active / keep** — keine auffälligen Befunde.

### `system_settings` — 1 Zeilen, 5 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `updated_at` | constant-in-prod | `distinct = 1` | keep |  |
| `updated_by_user_id` | empty-in-prod | `filled = 0 / 1` | observe |  |

### `tasks` — 95 Zeilen, 13 Spalten

Alle 13 Spalten **active / keep** — keine auffälligen Befunde.

### `user_roles` — 64 Zeilen, 4 Spalten

Alle 4 Spalten **active / keep** — keine auffälligen Befunde.

### `user_whatsapp_preferences` — 10 Zeilen, 6 Spalten

Alle 6 Spalten **active / keep** — keine auffälligen Befunde.

### `users` — 23 Zeilen, 37 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `notfallkontakt_name` | empty-in-prod | `filled = 0 / 23` | observe |  |
| `notfallkontakt_telefon` | empty-in-prod | `filled = 0 / 23` | observe |  |
| `notfallkontakt_beziehung` | empty-in-prod | `filled = 0 / 23` | observe |  |
| `employment_status` | constant-in-prod | `distinct = 1` | keep |  |
| `lbnr` | empty-in-prod | `filled = 0 / 23` | observe |  |
| `personalnummer` | empty-in-prod | `filled = 0 / 23` | observe |  |
| `is_super_admin` | low-usage | `filled = 1/23` | keep |  |

`notfallkontakt_*`, `lbnr`, `personalnummer` sind im Mitarbeiter-Profil-UI sichtbar; leeres Vorkommen = Pflegelücke, kein Code-Defekt. → **observe** + Daten nachpflegen.

### `whatsapp_message_log` — 0 Zeilen, 9 Spalten
> Inbound/outbound Log; aktuell leer. **observe**.

**Tabelle ist leer in Prod.** SQL-Evidenz: `SELECT COUNT(*) FROM "whatsapp_message_log" → 0`.

### `whatsapp_notification_rules` — 7 Zeilen, 7 Spalten

| Spalte | Klassifikation | SQL-Evidenz | Empfehlung | Notiz |
|---|---|---|---|---|
| `enabled` | empty-in-prod | `filled = 0 / 7` | observe |  |

---

## 5. Empfehlungs-Übersicht

### 5.1 drop-migration (eindeutig)

Eintrag erfolgt nur, wenn **alle** folgenden Bedingungen erfüllt sind: leer in Prod (oder konstanter Default), kein produktiver Schreib-Pfad, kein produktiver Lese-Pfad oder eindeutig durch Nachfolger ersetzt.

| Objekt | Typ | Begründung | SQL-Evidenz |
|---|---|---|---|
| `customer_pricing_history` | **Tabelle** | 0 Zeilen, kein Storage-Read/Write, nur in Cleanup-Skripten referenziert | `SELECT COUNT(*) FROM customer_pricing_history → 0` + `rg "customerPricingHistory" server/storage/` ergibt 0 Treffer |
| `appointments.services_done` (text[]) | Spalte | 0/735 nicht-leere Arrays, ersetzt durch `appointment_services` | `SELECT COUNT(*) FILTER (WHERE array_length(services_done, 1) > 0) FROM appointments → 0` |
| `customer_contracts.hauswirtschaft_rate_cents` | Spalte | 108/108 = 0 (Default), ersetzt durch `customer_service_prices` | `SELECT COUNT(DISTINCT hauswirtschaft_rate_cents), MAX(hauswirtschaft_rate_cents) FROM customer_contracts → 1, 0` |
| `customer_contracts.alltagsbegleitung_rate_cents` | Spalte | 108/108 = 0 (Default) | `SELECT COUNT(DISTINCT alltagsbegleitung_rate_cents), MAX(alltagsbegleitung_rate_cents) FROM customer_contracts → 1, 0` |
| `customer_contracts.kilometer_rate_cents` | Spalte | 108/108 = 0 (Default) | `SELECT COUNT(DISTINCT kilometer_rate_cents), MAX(kilometer_rate_cents) FROM customer_contracts → 1, 0` |

> **Hinweis:** Die in §5.1 genannten Drops dürfen erst nach erfolgreicher Verifikation durch ein Refactoring-Task erfolgen (Lese-Pfade in Code/Reports/PDF-Templates final entfernen). Dieser Audit liefert die Faktenbasis, schreibt aber keine Migrationen.

> **Wichtig — was NICHT in §5.1 steht:** `customers.name` (`filled = 133/133`), `customers.telefon` (`filled = 88/133`), `customer_contracts.hours_per_period` (`filled = 63/108`), `customer_contracts.period_type` (`distinct = 2`), `appointments.service_type` (`filled = 122/735`) sind im Schema als Legacy markiert, **enthalten aber produktive Daten** und/oder werden weiterhin gelesen. Sie stehen in §5.2 (observe) — Drop erst nach Daten-Migration und Lese-Pfad-Bereinigung.

### 5.2 observe (3 Monate beobachten oder Daten-Migration nötig)

| Objekt | SQL-Evidenz | Begründung |
|---|---|---|
| `customers.name` (Legacy) | `filled = 133 / 133, distinct = 128` | Voll befüllt, Lese-Pfade müssen vor Drop bereinigt werden |
| `customers.telefon` (Legacy) | `filled = 88 / 133, distinct = 76` | Migration nach `customer_contacts.festnetz/mobilnummer` unvollständig (5 + 11 von 112 Kontakten) |
| `customer_contracts.hours_per_period` | `filled = 63 / 108, distinct = 5` | Schema-Marker irreführend — Spalte aktiv genutzt |
| `customer_contracts.period_type` | `distinct = 2` (month, week) | Schema-Marker irreführend — Spalte aktiv genutzt |
| `appointments.service_type` | `filled = 122 / 735, distinct = 2` | Legacy, aber aktiv von Budget/Import gelesen |
| `appointments.is_series_exception` | `filled = 0 / 735` (alle false) | Code-Pfad existiert (Serien-Ausnahmen) |
| `appointments.doctor_latitude` / `doctor_longitude` | `filled = 0` von 9 Fahrtdienst-Terminen | Geocoding-Code-Pfad existiert |
| `appointments.signature_data/_hash`, `signed_at`, `signed_by_user_id` | `filled = 15 / 735` | Signing produktiv genutzt, niedrige Quote erwartet |
| `customers.is_anonymized`, `anonymized_at`, `converted_from_prospect_id`, `receives_monthly_invoice` | `filled = 0 / 133` | DSGVO-/Lifecycle-Felder, Code-Pfad existiert |
| `customers.accepts_private_payment` (1/133), `merged_into_customer_id` (6/133), `backup_employee_id_2` (5/133), `beihilfe_berechtigt` (1/133) | low-usage | sinnvoller Edge-Case |
| `customer_budgets.entlastungsbetrag_45b` | `distinct = 1 / 17` | Default, neuer Pfad über `budget_allocations` |
| `customer_budgets` (Tabelle gesamt) | 17 rows | Legacy-Snapshot, parallel zu `budget_allocations` aktiv genutzt |
| `customer_budget_preferences.monthly_limit_cents` | `filled = 0 / 33` | Code prüft aber `monthlyLimitCents !== null` |
| `customer_needs_assessments.service_*` (16 Booleans) | `true_count = 0 / 1` | UI vorhanden, aber keine Daten |
| `customer_care_level_history.pflegegrad_beantragt`, `notes` | `filled = 0 / 117` | empty, Workflow-Felder |
| `customer_insurance_history.valid_to`, `notes` | `filled = 0 / 104` | empty bei 104 Zeilen — nicht alle Versicherungen abgelaufen |
| `customer_documents.review_due_date`, `notes` | `filled = 0 / 585` | Review-Workflow für Kunden noch nicht aktiv |
| `document_types.renewal_days` | `filled = 0 / 27` | Wiedervorlage-Logik nicht konfiguriert |
| `employee_documents.deleted_at` (0/47), `review_due_date` (2/47) | low-usage | Workflow neu |
| `employee_month_closings.reopened_at`, `reopened_by_user_id` | `filled = 0 / 2` | Reopening noch nicht passiert |
| `users.notfallkontakt_*`, `lbnr`, `personalnummer` | `filled = 0 / 23` jeweils | Pflege-Lücke, nicht Code-Defekt |
| `whatsapp_notification_rules.enabled` | `filled = 0 / 7` (NULL) | nullable boolean ohne Default — Backfill empfohlen |
| `prospects.converted_customer_id`, `assigned_employee_id`, `disqualification_reason` | `filled = 0 / 94` | niedrige Conversion-/Disqual.-Quote |
| `insurance_providers.anschrift`, `plz_ort` | `filled = 0 / 314` | Daten kommen aus `empfaenger_zeile1/2` |
| Leere Tabellen aus noch nicht aktiven Modulen (siehe §5.3) | `COUNT(*) = 0` | wie genannt |

### 5.3 keep (produktiv oder bewusst leer)

| Tabelle | Status |
|---|---|
| `appointment_services`, `appointments`, `appointment_series` | aktiv |
| `audit_log`, `notifications`, `tasks`, `sessions` | aktiv |
| `customers`, `customer_contacts`, `customer_assignment_history`, `customer_documents`, `customer_insurance_history`, `customer_care_level_history` | aktiv |
| `customer_contracts`, `customer_contract_rates`, `customer_service_prices` | aktiv |
| `budget_allocations`, `budget_transactions`, `customer_budget_type_settings`, `customer_budget_preferences` | aktiv |
| `services`, `service_budget_pots`, `monthly_service_records`, `service_record_appointments` | aktiv |
| `employee_documents`, `employee_time_entries`, `employee_month_closings`, `employee_vacation_allowance` | aktiv |
| `prospects`, `prospect_notes`, `scheduled_calls` | aktiv |
| `document_types`, `document_templates`, `document_template_billing_types`, `document_type_triggers`, `generated_documents` | aktiv |
| `insurance_providers`, `birthday_card_tracking`, `company_settings`, `system_settings` | aktiv (Stammdaten / Konfig) |
| `users`, `user_roles`, `user_whatsapp_preferences`, `whatsapp_notification_rules`, `password_reset_tokens`, `admin_permissions` | aktiv |
| **Leer-aber-erwartet:** `invoices`, `invoice_line_items`, `payment_advices`, `payment_advice_items`, `qonto_transactions`, `qualifications`, `qualification_documents`, `employee_qualifications`, `employee_document_proofs`, `employee_compensation_history`, `whatsapp_message_log`, `service_rates`, `prospect_offers`, `document_deliveries`, `document_signing_tokens` | Module scaffolded, noch nicht in Prod-Nutzung |

---

## 6. Cross-Check Storage-Layer (Reads/Writes)

Stichproben mit ripgrep (`server/`, `client/src/`):

| Tabelle/Spalte | Reads | Writes | Befund |
|---|---|---|---|
| `customer_pricing_history` | nur Cleanup-Scripts (`server/scripts/cleanup-test-data.ts`, `server/routes/admin/test-cleanup.ts`) | nur `UPDATE customer_id` in Merge-Util (`server/routes/admin/customers/duplicates.ts`) | **Orphan**, kein produktiver Pfad |
| `customer_budgets` | `server/storage/customer-mgmt/budgets.ts`, `server/storage/budget/allocation-storage.ts` | dieselben + Cleanup | Aktiv, aber Legacy parallel zu `budget_allocations` |
| `appointments.services_done` | nur historische Reads in Reports (Schema-Default `[]` greift) | kein produktiver Write | drop-fähig, sobald historische Reads konsumiert/migriert |
| `appointments.service_type` | aktiv gelesen in `server/storage/budget/*.ts`, Import-Routinen | wird beim Erstellen befüllt (122/735) | Legacy, aber **nicht ohne Refactoring** entfernbar |
| `appointments.is_series_exception` | gelesen in Series-Logik | beschrieben (Default false) — kein UI-Trigger setzt `true` | observe |
| `customer_contracts.hauswirtschaft/alltagsbegleitung/kilometer_rate_cents` | wenige Legacy-Reads in Vertrags-Detail-Anzeige | INSERT mit Default 0 | drop-fähig nach UI-Refactoring |
| `customer_contracts.hours_per_period` / `period_type` | aktiv gelesen | aktiv geschrieben (63/108 bzw. distinct=2) | **NICHT droppen** — trotz Legacy-Marker im Schema |
| `users.notfallkontakt_*`, `lbnr`, `personalnummer` | gelesen in Profil & Mitarbeiter-Liste | UPDATE-Pfad existiert | Daten-Pflege-Lücke |
| `prospects.raw_email_content`, `geo_qualified` | gelesen in Lead-Inbox | von Webhook geschrieben | aktiv (auch wenn aktuell low-usage) |
| `whatsapp_notification_rules.enabled` | gelesen | beim Update geschrieben — alle 7 Bestandsregeln vor Einführung des Felds angelegt | NULL-Backfill empfohlen |

---

## 7. Migrations-Historie (kurz)

Migrations-Verzeichnis: `migrations/0000_*` bis `migrations/0010_*` und `migrations/0012_*`. **`0011` fehlt** — vermutlich übersprungen oder per `db:push` nachgezogen. Kein Datenrisiko, aber Reihenfolge sollte dokumentiert werden.

---

## 8. Gesamt-Empfehlung & Folge-Tasks (nicht Bestandteil dieses Audits)

1. **Drop-Migration für `customer_pricing_history`** — eigener Task. Vorab: Lese-Pfade final ausschließen, Cleanup-Skripte anpassen.
2. **Refactoring `appointments.services_done`** — eigener Task. Reports/Exports umstellen auf `appointment_services`, dann Spalte droppen.
3. **Refactoring `customer_contracts.*_rate_cents`** — eigener Task. UI/Anzeige auf `customer_service_prices` umstellen, dann Spalten droppen.
4. **Bestehender Task `cleanup-contact-phone-fields.md`** deckt `customers.telefon` ab — koordinieren mit Daten-Migration `customers.name` → `vorname/nachname`.
5. **Re-Audit nach 3 Monaten** für alle „observe"-Einträge.
6. **Daten-Pflege-Initiative** für `users.notfallkontakt_*`, `lbnr`, `personalnummer` — kein Code-Issue, sondern Operations.
7. **Migrations-Lücke 0011** klären und dokumentieren.

---

*Ende des Reports.*
