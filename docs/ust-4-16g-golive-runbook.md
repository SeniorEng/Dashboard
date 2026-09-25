# Live-Gang USt-Regel § 4 Nr. 16 g UStG — Runbook

Ticket: `6hcgffPJWm57p72p`. Frist: **vor dem Oktober-Abrechnungslauf.**
Reihenfolge (Alrik, 25.09.2026): **Publish → Pflegegrad bei 177 austragen → Freigabe-Check leer → Abrechnungslauf.**

Jeder Schritt ist ein eigener Schritt. Prod-Schreibzugriffe gibt es nur in
Schritt 4 und 5, beide über die Oberfläche (mit Audit), nicht per SQL.

---

## 1. Vor dem Publish

### 1a. Schema-Änderung — nur additiv und nullable

| Tabelle | neue Spalte | leer = |
|---|---|---|
| `invoice_line_items` | `vat_rate_bp` (integer) | Bestand vor der Umstellung, rendert wie bisher |
| `invoice_line_items` | `pflegegrad_am_leistungstag` (integer) | Bestand |
| `customer_care_level_history` | `entfernt_am` (timestamp) | Eintrag gilt |
| `customer_care_level_history` | `entfernt_grund` (text) | — |
| `customer_care_level_history` | `entfernt_von_user_id` (integer, FK `users`) | — |

Keine Spalte fällt weg, keine wird `NOT NULL`, kein neuer Constraint auf
bestehende Zeilen. Der alte Code liest die neuen Spalten nicht und bedient im
Deploy-Fenster unverändert weiter.

### 1b. Pre-Publish-Gate

```bash
node script/preflight-publish.mjs
```

Erwartet: kein `DROP COLUMN` / `DROP TABLE`, kein verengender Typwechsel.
Ein Backup nach `docs/pre-publish-backup-runbook.md` ist für diesen Publish
**nicht** Pflicht (keine Drops), bleibt aber empfohlen.

### 1c. `.replit`-Build-Zeile prüfen

Im Repo steht:

```
build = ["sh", "-c", "npm run build && bash scripts/migrate.sh --force"]
```

CLAUDE.md (Ticket `6hWvrJgff5xr9hfp`) sagt, die Build-Zeile läuft derzeit
**ohne** `migrate.sh`, weil Schritt 0d gegen Prod nicht durchkommt.
**Vor dem Publish in Replit → Deployments nachsehen, welche Zeile aktiv ist.**
Für DIESEN Publish reicht beides: die Änderung ist additiv, Replits eigene
Schema-Phase wendet sie vor dem Build an.

## 2. Publish (Alrik)

## 3. Freigabe-Check — erster Lauf

Read-only, eine Zeile. Die SQL steht identisch in
`scripts/sql/ust-freigabe-check.sql`; der Test
`tests/billing/ust-4-16g.test.ts` führt genau diese Datei aus.

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "WITH h AS (SELECT * FROM customer_care_level_history WHERE entfernt_am IS NULL), q AS (SELECT c.id, c.billing_type, c.pflegegrad AS pg_stamm, (SELECT h.pflegegrad FROM h WHERE h.customer_id = c.id AND h.valid_from <= CURRENT_DATE AND (h.valid_to IS NULL OR h.valid_to >= CURRENT_DATE) ORDER BY h.valid_from DESC LIMIT 1) AS pg_historie FROM customers c WHERE c.deleted_at IS NULL) SELECT befund, customer_id, detail FROM ( SELECT 'A Selbstzahler mit Pflegegrad (Stammdaten)' AS befund, id AS customer_id, 'customers.pflegegrad = ' || pg_stamm AS detail FROM q WHERE billing_type = 'selbstzahler' AND pg_stamm IS NOT NULL UNION ALL SELECT 'B Selbstzahler mit Pflegegrad (Historie)', h.customer_id, 'Eintrag ' || h.id || ': PG ' || h.pflegegrad || ', ' || h.valid_from || ' bis ' || coalesce(h.valid_to::text, 'offen') FROM h JOIN customers c ON c.id = h.customer_id WHERE c.deleted_at IS NULL AND c.billing_type = 'selbstzahler' UNION ALL SELECT 'C Stammdaten und Historie weichen ab (heute)', id, 'Stammdaten ' || coalesce(pg_stamm::text, 'kein PG') || ', Historie ' || coalesce(pg_historie::text, 'kein PG') FROM q WHERE pg_stamm IS DISTINCT FROM pg_historie UNION ALL SELECT 'D mehrere laufende Eintraege', customer_id, count(*) || ' offene Eintraege' FROM h WHERE valid_to IS NULL GROUP BY customer_id HAVING count(*) > 1 UNION ALL SELECT 'E umgedrehter Zeitraum', customer_id, 'Eintrag ' || id || ': ' || valid_from || ' bis ' || valid_to FROM h WHERE valid_to < valid_from UNION ALL SELECT 'F Kassen-Termin ohne nachgewiesenen Pflegegrad (Datenfehler)', a.customer_id, 'Termin ' || a.id || ' am ' || a.date FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.billing_type <> 'selbstzahler' AND a.status = 'completed' AND a.date >= date_trunc('month', CURRENT_DATE - interval '1 month') AND NOT EXISTS (SELECT 1 FROM h WHERE h.customer_id = a.customer_id AND h.valid_from <= a.date AND (h.valid_to IS NULL OR h.valid_to >= a.date)) UNION ALL SELECT 'G Entwurf vor der Umstellung (verwerfen und neu erzeugen)', i.customer_id, i.invoice_number FROM invoices i WHERE i.status = 'entwurf' AND i.invoice_type IS DISTINCT FROM 'stornorechnung' AND EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = i.id AND l.vat_rate_bp IS NULL) UNION ALL SELECT 'H Entwurf passt nicht zur Historie (verwerfen und neu erzeugen)', i.customer_id, i.invoice_number || ': Position am ' || l.appointment_date || ' PG ' || coalesce(l.pflegegrad_am_leistungstag::text, 'kein') || ', Historie ' || coalesce((SELECT h.pflegegrad FROM h WHERE h.customer_id = i.customer_id AND h.valid_from <= l.appointment_date AND (h.valid_to IS NULL OR h.valid_to >= l.appointment_date) ORDER BY h.valid_from DESC LIMIT 1)::text, 'kein') FROM invoices i JOIN invoice_line_items l ON l.invoice_id = i.id WHERE i.status = 'entwurf' AND i.invoice_type IS DISTINCT FROM 'stornorechnung' AND l.vat_rate_bp IS NOT NULL AND l.pflegegrad_am_leistungstag IS DISTINCT FROM (SELECT h.pflegegrad FROM h WHERE h.customer_id = i.customer_id AND h.valid_from <= l.appointment_date AND (h.valid_to IS NULL OR h.valid_to >= l.appointment_date) ORDER BY h.valid_from DESC LIMIT 1) ) befunde ORDER BY befund, customer_id;"
```

| Befund | Bedeutung | Was tun |
|---|---|---|
| **A / B** | Selbstzahler mit Pflegegrad in Stammdaten bzw. Historie | **Erwartet: nur Kunde 177** (E4). Jeder weitere Treffer: Alrik bestätigt, dass der Pflegegrad echt ist — sonst wie 177 austragen. |
| **C** | Stammdaten und Historie weichen heute ab | Die Steuer liest nur die Historie. **Kassenkunden mit Pflegegrad NUR in den Stammdaten** verlieren sonst die Zeile „Pflegegrad: N" auf der Rechnung (der Stempel kommt aus der Historie) — Historie über die Oberfläche nachtragen (Entscheidung Alrik, RK-8). |
| **D / E** | zwei laufende Einträge / umgedrehter Zeitraum | falschen Eintrag „als Fehleintrag entfernen" |
| **F** | Kassen-Termin ohne nachgewiesenen Pflegegrad (RK-1) | Bleibt steuerfrei (Entscheidung RK-1) — Pflegegrad in der Historie nachtragen |
| **G** | Rechnungs-**Entwurf** aus der Zeit vor der Umstellung | Schritt 5 |
| **H** | Entwurf, dessen Pflegegrad je Position nicht mehr zur Historie passt (z. B. vor dem Austragen bei 177 erzeugt) | verwerfen und neu erzeugen wie Schritt 5 |

## 4. Pflegegrad bei 177 austragen (Alrik, Oberfläche)

Kundenprofil 177 → Übersicht → **Pflegegrad-Verlauf** → Eintrag
„PG 3 seit 01.08.2024" → **„Als Fehleintrag entfernen"**, Grund z. B.
„Pflegegrad nie bewilligt (Klärung 25.09.2026)".

Bei 177 gibt es keinen vorigen Eintrag — die Nachfrage „Pflegegrad N gilt
dann wieder ab … – übernehmen?" (RK-10) erscheint deshalb nicht. Erscheint sie
bei einem anderen Kunden, lebt der vorige Grad nur nach „Ja, übernehmen" wieder
auf.

Wirkung (abgenommen in `ust-4-16g.test.ts`, E4 → E3):
- der Eintrag zählt für **kein** Datum mehr, auch rückwirkend,
- die Stammdaten stehen danach auf „kein Pflegegrad",
- Audit „Pflegegrad geändert" mit Art `als_fehleintrag_entfernt` und Grund.

## 5. Entwürfe aus der Zeit vor der Umstellung (Befund G)

Entwürfe, die vor dem Publish entstanden, tragen die USt der alten Regel und
keinen Satz je Position. **Nicht versendete** Entwürfe: in der Abrechnung
„Entwürfe verwerfen" und neu erzeugen. Versendete Rechnungen bleiben
unverändert (GoBD); eine Korrektur liefe über Storno + Neuausstellung — laut
Messung vom 25.09.2026 ist **keine** bestehende Rechnung zu berichtigen.

## 6. Freigabe-Check — zweiter Lauf

Derselbe Befehl wie in Schritt 3. **Erwartet: leer** — oder jeder verbleibende
Treffer ist von Alrik bestätigt.

## 7. Oktober-Abrechnungslauf

---

## Rücknahme

Ein Code-Rollback lässt die neuen Spalten stehen; der alte Code liest sie
nicht. Nach der Umstellung erzeugte Rechnungen bleiben gültig und rendern
auch mit dem alten Code (der die Spalten ignoriert) — dann allerdings wieder
mit der Rechnungs-Ebene. Deshalb nach einem Rollback keine neuen Rechnungen
für Selbstzahler mit Pflegegrad erzeugen.
