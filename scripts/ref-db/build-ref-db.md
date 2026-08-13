# Referenz-DB aufbauen (pseudonymisierte Prod-Kopie für Analysen auf der Box)

Zweck: read-only-Analysen (§45b-Rückschau, B3-Bezifferung, Abrechnungs-Audits)
direkt auf der Box fahren, ohne Replit-Relay — **ohne dass Roh-PII die Box je
erreicht**.

**Designprinzip: pseudonymisiert an der Quelle.** Der Scrub läuft auf Replit,
bevor irgendetwas übertragen wird. Nur die bereinigte Datei reist.

---

## Pipeline

```
Prod (Neon)
  └─(1) pg_dump ──────────────► lokale Wegwerf-PG auf Replit
                                   └─(2) scrub-pii.sql
                                          └─(3) Verifikation BEIDE Richtungen
                                                 └─(4) pg_dump der bereinigten DB
                                                        └─(5) Transfer ──► Box
                                                                            └─(6) engeldesk_ref
```

### Schritt 1 — Prod-Dump in eine lokale Wegwerf-PG auf Replit

Nie direkt gegen Prod scrubben. Der Dump geht in eine Einweg-Datenbank; Prod
und die Neon-Kopie bleiben unberührt.

```bash
createdb ref_build
pg_dump "$PROD_DATABASE_URL" --no-owner --no-privileges | psql ref_build
```

Hängt der Voll-Dump (Neon-Last), auf die tatsächlich gelesenen Tabellen
einschränken. Für §45b-Analysen reichen acht:

```
customers · users · budget_allocations · budget_transactions
customer_budget_type_settings · customer_budget_preferences
customer_care_level_history · customer_needs_assessments · budget_reservations
```

Für Rechnungs-/Leistungsnachweis-Fragen zusätzlich `invoices`,
`invoice_line_items`, `appointments`, `monthly_service_records`, `services`.

> **Achtung bei Teil-Dumps:** der Scrub fasst Tabellen an, die dann fehlen
> (z.B. `whatsapp_message_log`). Das ist kein Problem — `psql` meldet den
> Fehler, aber die Transaktion bricht ab und **nichts** wird bereinigt. Bei
> Teil-Dumps deshalb die nicht vorhandenen Blöcke auskommentieren, oder besser:
> voll dumpen.

### Schritt 2 — Scrub

```bash
psql ref_build -f scripts/ref-db/scrub-pii.sql
```

Läuft in **einer Transaktion**: entweder alles oder nichts. Idempotent —
mehrfaches Ausführen ändert nichts mehr.

Was bereinigt wird und was bewusst bleibt, steht im Kopf von `scrub-pii.sql`.
Kurzfassung: Personen, Freitext, Sozialdaten, Signatur-**Daten**, Bank,
Auth-Secrets raus — IDs, Fremdschlüssel, Beträge, Zeitstempel, `pflegegrad`,
Signatur-**Status**, `services`, `ik_nummer` bleiben.

### Schritt 3 — Verifikation, PFLICHT, beide Richtungen

**Das ist das Gate.** Ohne diesen Schritt wird nicht weitergemacht, weil der
Scrub bis hierher nur strukturell geprüft ist, nicht gegen echte Daten.

**(a) Kein PII übrig — jede Zeile MUSS `0` liefern:**

```sql
SELECT 'sessions',        count(*) FROM sessions
UNION ALL SELECT 'reset_tokens',   count(*) FROM password_reset_tokens
UNION ALL SELECT 'signing_tokens', count(*) FROM document_signing_tokens
UNION ALL SELECT 'pw_hash',        count(*) FROM users WHERE password_hash <> 'SCRUBBED-NO-LOGIN'
UNION ALL SELECT 'kunde_mail',     count(*) FROM customers WHERE email NOT LIKE '%@example.invalid'
UNION ALL SELECT 'user_mail',      count(*) FROM users     WHERE email NOT LIKE '%@example.invalid'
UNION ALL SELECT 'appt_freitext',  count(*) FROM appointments
                                   WHERE signature_data IS NOT NULL OR notes IS NOT NULL
UNION ALL SELECT 'versichertennr', count(*) FROM customer_insurance_history
                                   WHERE versichertennummer IS NOT NULL
UNION ALL SELECT 'secrets',        count(*) FROM company_settings
  WHERE COALESCE(iban, bic, whatsapp_access_token, qonto_secret_key,
                 twilio_auth_token, letterxpress_api_key, graph_client_secret) IS NOT NULL;
```

Zusätzlich eine **Mustersuche** statt nur Spaltenprüfung — Freitext kann PII
enthalten, das keine Spalte verrät:

```sql
-- Erkennbare Muster in verbliebenem Freitext: Mail, Telefon, IBAN
SELECT 'restfreitext', count(*) FROM prospect_notes
WHERE note_text ~* '@|\+49|\d{4}\s?\d{4}|DE\d{20}';
```

**(b) Analyse-Daten intakt — jede Zeile MUSS `> 0` liefern:**

```sql
SELECT 'services',      count(*) FROM services WHERE name IS NOT NULL
UNION ALL SELECT 'allocations', count(*) FROM budget_allocations WHERE amount_cents IS NOT NULL
UNION ALL SELECT 'transaktionen', count(*) FROM budget_transactions WHERE amount_cents IS NOT NULL
UNION ALL SELECT 'pflegegrade', count(*) FROM customers WHERE pflegegrad IS NOT NULL
UNION ALL SELECT 'signiert',    count(*) FROM appointments WHERE signed_at IS NOT NULL
UNION ALL SELECT 'rechnungen',  count(*) FROM invoices WHERE issued_at IS NOT NULL;
```

Ist **(b)** irgendwo `0`, hat der Scrub zu viel getroffen — dann nicht
weitermachen, sondern die betroffene Spalte in `scrub-pii.sql` prüfen.

### Schritt 4 — Dump der bereinigten DB

**Erst nach bestandener Verifikation.**

```bash
pg_dump ref_build --no-owner --no-privileges -Fc > engeldesk-ref-$(date +%F).dump
dropdb ref_build          # Wegwerf-DB sofort weg
```

### Schritt 5 — Transfer Replit → Box

Ich kann von der Box aus **nicht** auf Replit zugreifen; der Transfer geht
deshalb von Replit **zur** Box:

```bash
scp engeldesk-ref-$(date +%F).dump dev@engeldesk-01:/home/dev/
```

Falls `scp` von Replit aus nicht geht (kein ausgehendes SSH), alternativ über
eine Ablage, auf die beide Seiten kommen — der Weg ist beliebig, solange **nur
die bereinigte Datei** reist. Der Roh-Dump aus Schritt 1 verlässt Replit nie.

### Schritt 6 — Einspielen auf der Box

```bash
psql -c "DROP DATABASE IF EXISTS engeldesk_ref"
psql -c "CREATE DATABASE engeldesk_ref"
pg_restore -d engeldesk_ref --no-owner --no-privileges engeldesk-ref-*.dump
```

**Nutzung ausschließlich read-only**, mit dem direkten Postgres-Treiber:

```bash
DB_DRIVER=pg DATABASE_URL=postgres://…/engeldesk_ref \
  npx tsx server/scripts/<analyse-skript>.ts
```

Empfehlung: dafür einen eigenen DB-Rollennutzer mit `CONNECT`/`SELECT` anlegen
und den in der `DATABASE_URL` verwenden. Dann ist „read-only" nicht Disziplin,
sondern erzwungen — und ein Werkzeug, das versehentlich schreibt, scheitert
laut statt still.

---

## Geprüft

- **Kein eingehender Fremdschlüssel** auf `sessions`, `password_reset_tokens`
  oder `document_signing_tokens` (`pg_constraint`-Abfrage, leeres Ergebnis).
  Das `DELETE` in Schritt 2 kann also keine Integrität verletzen und keine
  behaltene Tabelle mitreißen.
- `scrub-pii.sql` läuft fehlerfrei gegen eine Schema-Kopie; die
  „muss 0"-Richtung der Verifikation ist dort bestätigt.
- **Offen:** die „muss > 0"-Richtung gegen echte Daten. Die Schema-Kopie ist
  leer, deshalb ist der erste Lauf nach Schritt 3 das eigentliche Gate.

## Auffrischen

Die Referenz-DB veraltet. Zum Auffrischen dieselbe Pipeline von vorn — sie ist
darauf ausgelegt, wiederholbar zu sein. Vorher die alte `engeldesk_ref`
verwerfen, damit keine zwei Stände nebeneinander liegen und niemand gegen den
falschen analysiert.
