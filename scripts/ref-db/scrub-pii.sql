-- =====================================================================
-- PII-SCRUB für die Referenz-DB
--
-- Zweck: aus einer Prod-Kopie eine pseudonymisierte Analyse-DB machen, die
-- auf der Entwickler-Box liegen darf. Läuft AN DER QUELLE (auf der Kopie),
-- bevor die Daten die Box erreichen — die Box sieht nie Roh-PII.
--
-- ── Was unangetastet bleibt (und warum) ──────────────────────────────
-- IDs, Fremdschlüssel, Beträge (`*_cents`), Zeitstempel, `pflegegrad`,
-- `budget_type`, `source`, `status`, `valid_from`/`expires_at`,
-- Signatur-STATUS (`*_signed_at`, `*_signed_by_user_id`, `employee_signed`,
-- `customer_signed`). Ohne diese Felder wäre die DB für Abrechnungs-,
-- §45b- und Leistungsnachweis-Analysen wertlos, und die referenzielle
-- Integrität muss für Joins erhalten bleiben.
--
-- Ebenfalls BEHALTEN, nach Gate-2-Freigabe: `services.name/description`,
-- `qualifications.*`, `document_templates.*`, `whatsapp_notification_rules.*`,
-- `payment_advices.insurance_provider_name/kostentraeger_name`, alle
-- `ik_nummer` (Institutionskennzeichen, kein Personenbezug) und die
-- `company_settings`-Firmenstammdaten (eigene Daten; die DB verlässt die Box
-- nicht).
--
-- ── Pseudonymisierungs-Regeln ────────────────────────────────────────
--   Namen        → "Kunde <id>" / "Mitarbeiter <id>"  (Listen bleiben lesbar)
--   E-Mail/Tel.  → deterministisch aus der Zeilen-ID (Unique-Constraints und
--                  Gruppierungen bleiben funktionsfähig)
--   Freitext     → NULL, bzw. 'SCRUBBED' wo die Spalte NOT NULL ist
--   Geburtsdatum → 01.01. des Geburtsjahres (Alters-/Geburtstagslogik bleibt)
--   Auth-Secrets → gelöscht bzw. unbrauchbarer Platzhalter
--
-- ── NOT NULL / CHECK ────────────────────────────────────────────────
-- Alle Ziel-Spalten wurden per `information_schema` gegen `is_nullable='NO'`
-- und per `pg_constraint` gegen CHECK-Constraints geprüft. Drei Spalten sind
-- NOT NULL und bekommen deshalb den Platzhalter 'SCRUBBED' statt NULL:
--   customers.address · customer_insurance_history.versichertennummer
--   · prospect_notes.note_text
-- Der erste echte Lauf brach an der ersten davon ab; die anderen beiden wären
-- als Nächstes gefolgt. CHECK-Constraints gibt es auf den berührten Tabellen
-- nur einen (`qonto_transactions_match_xor`), und er betrifft keine
-- Scrub-Spalte — die Platzhalter können ihn nicht verletzen.
--
-- IDEMPOTENT: mehrfaches Ausführen ändert nichts mehr.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. AUTH-SECRETS — dürfen so wenig auf die Box wie die WhatsApp-Tokens.
--
-- `token_hash` ist in allen drei Token-Tabellen NOT NULL: dort wird gelöscht
-- statt geleert. Das ist unkritisch — Sessions und Reset-Tokens sind
-- kurzlebig und für keine Analyse relevant.
-- ---------------------------------------------------------------------
DELETE FROM sessions;
DELETE FROM password_reset_tokens;
DELETE FROM document_signing_tokens;

-- `users.password_hash` ist NOT NULL → unbrauchbarer Platzhalter statt NULL.
-- Kein gültiger bcrypt/argon2-Wert, damit niemand sich einloggen kann.
UPDATE users SET password_hash = 'SCRUBBED-NO-LOGIN';

UPDATE company_settings SET
  graph_client_secret   = NULL,
  letterxpress_api_key  = NULL,
  qonto_secret_key      = NULL,
  twilio_auth_token     = NULL,
  whatsapp_access_token = NULL,
  -- Provider-Kennungen: keine Secrets, aber Konto-Identifikatoren.
  whatsapp_business_account_id = NULL,
  whatsapp_phone_number_id     = NULL,
  letterxpress_username        = NULL,
  twilio_phone_number          = NULL,
  lead_call_bridge_phone       = NULL;

-- ---------------------------------------------------------------------
-- 2. PERSONEN — Kunden, Mitarbeiter, Kontakte, Interessenten.
--
-- Namen werden nummeriert statt geleert, damit Listen und Gruppierungen
-- lesbar bleiben. E-Mail/Telefon deterministisch aus der ID, damit
-- Unique-Constraints halten und "wie viele verschiedene" weiter stimmt.
-- ---------------------------------------------------------------------
UPDATE customers SET
  vorname      = 'Kunde',
  nachname     = id::text,
  name         = 'Kunde ' || id::text,
  strasse      = 'Teststraße',
  nr           = (id % 200 + 1)::text,   -- Hausnummer (heisst hier `nr`)
  plz          = '10115',
  stadt        = 'Berlin',
  -- NOT NULL: Platzhalter statt NULL (erster echter Lauf brach hier ab).
  address      = 'SCRUBBED',
  telefon      = '+49301000' || lpad(id::text, 4, '0'),
  email        = 'kunde-' || id::text || '@example.invalid',
  -- Gate-2-Entscheidung (1): Jahr bleibt, Tag/Monat auf den 01.01.
  geburtsdatum = CASE WHEN geburtsdatum IS NULL THEN NULL
                      ELSE make_date(EXTRACT(YEAR FROM geburtsdatum)::int, 1, 1) END;

UPDATE users SET
  vorname                 = 'Mitarbeiter',
  nachname                = id::text,
  display_name            = 'Mitarbeiter ' || id::text,
  strasse                 = 'Teststraße',
  hausnummer              = (id % 200 + 1)::text,
  plz                     = '10115',
  stadt                   = 'Berlin',
  telefon                 = '+49302000' || lpad(id::text, 4, '0'),
  email                   = 'mitarbeiter-' || id::text || '@example.invalid',
  geburtsdatum            = CASE WHEN geburtsdatum IS NULL THEN NULL
                                 ELSE make_date(EXTRACT(YEAR FROM geburtsdatum)::int, 1, 1) END,
  notfallkontakt_name     = NULL,
  notfallkontakt_telefon  = NULL,
  notfallkontakt_beziehung = NULL;

UPDATE customer_contacts SET
  vorname     = 'Kontakt',
  nachname    = id::text,
  email       = 'kontakt-' || id::text || '@example.invalid',
  mobilnummer = '+49303000' || lpad(id::text, 4, '0'),
  notes       = NULL;
  -- `contact_type` bleibt: enum-artig, kein Personenbezug.

UPDATE prospects SET
  vorname           = 'Interessent',
  nachname          = id::text,
  strasse           = 'Teststraße',
  plz               = '10115',
  stadt             = 'Berlin',
  telefon           = '+49304000' || lpad(id::text, 4, '0'),
  email             = 'interessent-' || id::text || '@example.invalid',
  raw_email_content = NULL,   -- eingehende Mails: Freitext mit Personenbezug
  status_notiz      = NULL;

UPDATE prospect_notes    SET note_text = 'SCRUBBED';   -- NOT NULL
UPDATE scheduled_calls   SET lead_name = 'Lead ' || id::text,
                             lead_phone = '+49305000' || lpad(id::text, 4, '0');

-- ---------------------------------------------------------------------
-- 3. SOZIALDATEN / KENNUNGEN
--
-- `versichertennummer` ist ein Sozialdatum. `ik_nummer` bleibt (Gate-2-
-- Entscheidung 2): Institutionskennzeichen der Kasse, kein Personenbezug,
-- und die Kostenträger-Auflösung hängt daran.
-- ---------------------------------------------------------------------
UPDATE customer_budget_recipients SET
  recipient_name     = 'Empfänger ' || id::text,
  recipient_address  = NULL,
  versichertennummer = NULL,
  notes              = NULL;

UPDATE customer_insurance_history SET
  versichertennummer = 'SCRUBBED',   -- NOT NULL
  notes              = NULL;

-- ---------------------------------------------------------------------
-- 4. SIGNATUR-DATEN — nur die Bilder/Hashes, NICHT der Status.
--
-- `*_signed_at`, `*_signed_by_user_id`, `employee_signed`, `customer_signed`
-- bleiben unangetastet: Leistungsnachweis- und Abrechnungsanalysen hängen
-- daran (Gate-2-Vorgabe).
-- ---------------------------------------------------------------------
UPDATE appointments SET
  signature_data = NULL,
  signature_hash = NULL;

UPDATE monthly_service_records SET
  customer_signature_data = NULL,
  customer_signature_hash = NULL,
  employee_signature_data = NULL,
  employee_signature_hash = NULL;

UPDATE generated_documents SET
  customer_signature_data = NULL,
  employee_signature_data = NULL;

-- ---------------------------------------------------------------------
-- 5. ARZTDATEN am Termin
-- ---------------------------------------------------------------------
UPDATE appointments SET
  doctor_name    = NULL,
  doctor_strasse = NULL,
  doctor_plz     = NULL,
  doctor_stadt   = NULL;

-- ---------------------------------------------------------------------
-- 6. FREITEXT — überall dort, wo Pflegekräfte über Klienten schreiben.
-- Konsequent NULL statt Platzhalter: ein Platzhalter suggeriert Inhalt.
-- ---------------------------------------------------------------------
UPDATE appointments               SET notes = NULL, no_show_notes = NULL, no_show_reason_text = NULL;
UPDATE appointment_series         SET notes = NULL;
UPDATE budget_allocations         SET notes = NULL;
UPDATE budget_transactions        SET notes = NULL;
UPDATE customer_budget_preferences SET notes = NULL;
UPDATE customer_care_level_history SET notes = NULL;
UPDATE customer_contracts         SET notes = NULL;
UPDATE customer_documents         SET notes = NULL, file_name = 'dokument-' || id::text || '.pdf';
UPDATE birthday_card_tracking     SET notes = NULL;
UPDATE payment_advices            SET notes = NULL, file_name = 'avis-' || id::text || '.pdf';

-- ---------------------------------------------------------------------
-- 7. ZUSTELLUNG & KOMMUNIKATION
-- ---------------------------------------------------------------------
UPDATE document_deliveries SET
  recipient_name       = 'Empfänger ' || id::text,
  recipient_address    = NULL,
  recipient_email      = 'empfaenger-' || id::text || '@example.invalid',
  document_file_names  = NULL,
  error_message        = NULL;   -- enthält oft Adressen/Mails im Klartext

UPDATE whatsapp_message_log SET
  phone_number    = '+49306000' || lpad(id::text, 4, '0'),
  meta_message_id = NULL,
  error_message   = NULL;
  -- `template_name` bleibt: Konfiguration, kein Personenbezug.

UPDATE user_whatsapp_preferences SET
  whatsapp_number = '+49307000' || lpad(user_id::text, 4, '0');

-- ---------------------------------------------------------------------
-- 8. BANKDATEN
--
-- `company_settings`-Firmenstammdaten (company_name, strasse, plz, stadt)
-- bleiben (Gate-2-Entscheidung 3). Die Bankverbindung nicht.
-- ---------------------------------------------------------------------
UPDATE company_settings SET
  iban      = NULL,
  bic       = NULL,
  bank_name = NULL,
  qonto_iban = NULL;

UPDATE qonto_transactions SET
  counterparty_name = 'Gegenkonto ' || id::text,
  source_iban       = NULL;

UPDATE payment_advices SET
  zahlungsempfaenger_iban = NULL;
  -- `insurance_provider_name` / `kostentraeger_name` bleiben: Institutionen.

-- ---------------------------------------------------------------------
-- 9. TECHNISCHE SPUREN
-- ---------------------------------------------------------------------
UPDATE audit_log SET ip_address = NULL;

COMMIT;

-- =====================================================================
-- GEGENPROBE — nach dem Lauf ausführen. Jede Zeile MUSS 0 liefern.
-- =====================================================================
-- SELECT count(*) FROM sessions;
-- SELECT count(*) FROM password_reset_tokens;
-- SELECT count(*) FROM document_signing_tokens;
-- SELECT count(*) FROM users WHERE password_hash <> 'SCRUBBED-NO-LOGIN';
-- SELECT count(*) FROM customers WHERE email NOT LIKE '%@example.invalid';
-- SELECT count(*) FROM users     WHERE email NOT LIKE '%@example.invalid';
-- SELECT count(*) FROM appointments WHERE signature_data IS NOT NULL
--                                      OR notes IS NOT NULL;
-- SELECT count(*) FROM company_settings
--   WHERE COALESCE(iban, bic, whatsapp_access_token, qonto_secret_key,
--                  twilio_auth_token, letterxpress_api_key,
--                  graph_client_secret) IS NOT NULL;
--
-- UND die Gegenrichtung — diese MÜSSEN > 0 bleiben, sonst wurde zu viel
-- bereinigt:
-- SELECT count(*) FROM services WHERE name IS NOT NULL;
-- SELECT count(*) FROM appointments WHERE signed_at IS NOT NULL;
-- SELECT count(*) FROM budget_allocations WHERE amount_cents IS NOT NULL;
-- SELECT count(*) FROM customers WHERE pflegegrad IS NOT NULL;
-- =====================================================================
