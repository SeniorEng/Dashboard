-- Cutover-Aufräumung (A3) — entfernt Objekte, die in Prod existieren, aber in
-- keiner Quelle des Repos stehen. Vorwärts-Schritt, kein Rollback-Pfad.
--
-- HANDGESCHRIEBEN (anders als `0001_gobd_triggers.sql`, das generiert ist).
--
-- WAS HIER STEHT, IST AM PROD-DUMP GEMESSEN, nicht aus dem Code geschlossen:
-- `~/prod-schema.sql` (03.08.2026, schema-only, `pg_dump --schema=public`).
-- Read-only geprüft am 05.08.2026:
--
--   audit_log_parent_deletion_id_fkey        VORHANDEN  -> wird hier gedroppt
--   budget_ledger_prevent_delete/update/…    VORHANDEN  -> siehe unten, NICHT hier
--   appointments_prospect_or_customer_check  NICHT DA   -> steht deshalb NICHT hier
--
-- Der CHECK fehlt bewusst: Prod hat ihn nicht. Ein `DROP ... IF EXISTS` darauf
-- wäre zwar harmlos, würde aber eine Behauptung über Prod festschreiben, die
-- der Dump nicht deckt. Anlegen tut ihn weiterhin nur
-- `server/startup/migrate-erstberatung-customers.ts`, ledger-gegated.
--
-- Die drei verwaisten `budget_ledger_prevent_*`-Funktionen stehen NICHT hier,
-- obwohl sie Prod-Cruft sind: `0001_gobd_triggers.sql` droppt sie bereits in
-- seinem Abschnitt 1, weil sie zur Trigger-/Funktions-SSoT gehören. Sie hier zu
-- wiederholen hiesse, dieselbe fachliche Frage an zwei Stellen zu beantworten.
--
-- IDEMPOTENZ: `IF EXISTS` durchgehend — auf einer frisch aus der Baseline
-- gebauten DB ist diese Datei ein No-Op, auf einer restaurierten Prod-DB tut
-- sie echte Arbeit. Beide Wege laufen durch dieselbe Datei; genau das ist der
-- Konvergenz-Beweis.

-- ---------------------------------------------------------------------------
-- 1) Doppelter Fremdschlüssel auf `audit_log.parent_deletion_id`.
--
-- Prod trägt ZWEI funktional identische FKs auf derselben Spalte:
--   audit_log_parent_deletion_id_audit_log_id_fk  (Drizzle-Name, kanonisch —
--                                                  im Modell und in der Baseline)
--   audit_log_parent_deletion_id_fkey             (PostgreSQL-Default-Name)
--
-- Entstanden durch ein Ping-Pong: `drizzle-kit push --force` droppte den
-- `_fkey` (steht nicht im Modell), der nächste Boot legte ihn namensgleich
-- wieder an, weil die Startup-Prüfung NAMENS-basiert war. PR #41 hat die
-- Prüfung auf SPALTEN-basiert umgestellt — seitdem legt der Startup nichts mehr
-- nach, entfernt das Duplikat aber auch nicht. Das tut diese Zeile.
--
-- Kosten des Duplikats: ein zweiter vollständiger Satz interner RI-Trigger auf
-- `audit_log`, der schreibintensivsten Tabelle der App.
--
-- Nur der DUPLIKAT-Name wird gedroppt. Der kanonische FK bleibt und wird auf
-- einer leeren DB von der Baseline angelegt.
ALTER TABLE IF EXISTS audit_log
  DROP CONSTRAINT IF EXISTS audit_log_parent_deletion_id_fkey;

-- ---------------------------------------------------------------------------
-- 2) Baseline-Angleich: zwei Indizes, die `main` hat und Prod nicht.
--
-- DIESER ABSCHNITT IST DER EIGENTLICHE BEFUND VON A3, nicht Beiwerk.
--
-- Das Stempeln der Baseline (`--stamp-baseline`) behauptet: „diese Datenbank
-- hat den Zustand, den 0000 beschreibt". Die Konvergenz-Gegenprobe hat gezeigt,
-- dass diese Behauptung heute FALSCH ist — Prod hängt hinter `main` zurück,
-- weil seit den beiden Merges nicht deployt wurde:
--
--   customer_insurance_history_valid_idx
--     Modell/Baseline: (customer_id, valid_from, valid_to)   [#1893, 88f3d3da]
--     Prod (03.08.):   (customer_id, valid_to)               — alte Fassung
--
--   invoice_line_items_appointment_id_idx
--     Modell/Baseline: vorhanden                             [#30, 938459eb]
--     Prod (03.08.):   fehlt
--
-- Ohne diesen Abschnitt würden beide Abweichungen den Cutover ÜBERLEBEN: der
-- Stempel sagt „0000 ist angewendet", also fasst der Migrator die Baseline nie
-- wieder an, und `drizzle-kit push` — das sie bisher stillschweigend
-- nachgezogen hätte — soll ja gerade ersetzt werden. Sie blieben dauerhaft
-- stehen, ohne dass irgendetwas sie meldet.
--
-- Beide Statements sind vorwärts und idempotent: auf einer frisch aus der
-- Baseline gebauten DB stellen sie denselben Zustand wieder her (DROP+CREATE
-- derselben Definition), auf der restaurierten Prod korrigieren sie.
--
-- ACHTUNG — DAS HIER IST EINE MOMENTAUFNAHME, KEIN MECHANISMUS. Die Werte sind
-- am Dump vom 03.08.2026 gemessen. Wird Prod vor dem Cutover deployt,
-- verschwindet die Abweichung von selbst und dieser Abschnitt wird zum No-Op
-- (schadet dann nicht). Die tragfähige Lösung ist ein Preflight, der vor dem
-- Stempeln prüft, ob die Ziel-DB der Baseline wirklich entspricht, statt es zu
-- unterstellen — siehe FINDING im PR-Body. Das ist bewusst NICHT A3.
DROP INDEX IF EXISTS customer_insurance_history_valid_idx;
CREATE INDEX IF NOT EXISTS customer_insurance_history_valid_idx
  ON customer_insurance_history (customer_id, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS invoice_line_items_appointment_id_idx
  ON invoice_line_items (appointment_id);
