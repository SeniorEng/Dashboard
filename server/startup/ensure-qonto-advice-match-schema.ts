import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1672 — Schema-Erweiterung für den Sammel-Avis ↔ Sammelzahlung-Match.
 *
 * Additiv/expand-safe (kein destruktiver Diff), idempotent:
 *  - Spalte `matched_payment_advice_id` (FK → payment_advices): eine
 *    Sammelzahlung zeigt auf ein ganzes Avis statt auf eine Einzelrechnung.
 *  - Spalte `advice_suggestion_dismissed_at`: abgelehnte rückwirkende
 *    Vorschläge tauchen beim nächsten Sync/Import nicht erneut auf.
 *  - Partieller Unique-Index (ein Avis ↔ eine Zahlung).
 *  - Such-Index auf der FK-Spalte.
 *  - XOR-Check: nie gleichzeitig auf Einzelrechnung UND Avis gebunden.
 *
 * Kein `drizzle-kit push`. Bei existierenden verletzenden Daten schlägt nur der
 * jeweilige Schritt fehl (Fehler geloggt, Boot läuft weiter).
 */
// Einzeln exportierte SSoT-Konstanten statt nur des Sammel-Arrays: der
// Drift-Wächter (`tests/startup/startup-schema-drift.test.ts`) spielt JEDE
// dieser Anweisungen gegen eine TEMP-Tabelle und vergleicht das von PostgreSQL
// normalisierte Ergebnis mit der Drizzle-Deklaration. Dafür braucht er die
// Statements benannt und einzeln — ein Index-Griff ins Array wäre gegen jede
// Umsortierung fragil. Das ausgeführte SQL bleibt unverändert; `QONTO_ADVICE_MATCH_DDL`
// wird unten aus genau diesen Konstanten zusammengesetzt.

export const QONTO_MATCHED_ADVICE_ID_COLUMN_SQL = `ALTER TABLE qonto_transactions
     ADD COLUMN IF NOT EXISTS matched_payment_advice_id integer
     REFERENCES payment_advices(id)`;

/**
 * Zeitzonen-behaftet — Projekt-Konvention.
 *
 * Diese Spalte wurde ursprünglich als plain `timestamp` (ohne Zeitzone)
 * angelegt, während das Drizzle-Modell den `timestamp`-Helper aus
 * `shared/schema/common.ts` nutzt, der IMMER `withTimezone: true` setzt. Der
 * Spaltentyp hing damit davon ab, welcher Pfad sie erzeugt hat: per
 * `drizzle-kit push` gebaute DBs bekamen `timestamptz`, per Startup-DDL gebaute
 * `timestamp`. Aufgedeckt hat das der neue ADD-COLUMN-Coverage-Scan im
 * Drift-Wächter.
 *
 * ACHTUNG — diese Korrektur wirkt NUR auf DBs, in denen die Spalte noch nicht
 * existiert: `ADD COLUMN IF NOT EXISTS` lässt eine vorhandene Spalte
 * unangetastet und altert sie NICHT nach. Bestehende Datenbanken behalten
 * `timestamp`, bis die Spalte in `RECONCILE_COLUMN_TYPE_TARGETS`
 * (`reconcile-drifted-column-types.ts`) aufgenommen wird — dort passiert das
 * idempotente `ALTER COLUMN … SET DATA TYPE`. Das ist bewusst ein eigener,
 * gegateter Schritt, weil es eine Typkonvertierung auf echten Daten ist.
 */
export const QONTO_ADVICE_DISMISSED_AT_COLUMN_SQL = `ALTER TABLE qonto_transactions
     ADD COLUMN IF NOT EXISTS advice_suggestion_dismissed_at timestamptz`;

export const QONTO_MATCHED_ADVICE_UNIQUE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS qonto_transactions_matched_advice_unique_idx
     ON qonto_transactions (matched_payment_advice_id)
     WHERE matched_payment_advice_id IS NOT NULL`;

export const QONTO_MATCHED_ADVICE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS qonto_transactions_matched_advice_idx
     ON qonto_transactions (matched_payment_advice_id)`;

export const QONTO_MATCH_XOR_CHECK_NAME = "qonto_transactions_match_xor";

/**
 * Plain-DDL des XOR-Checks — OHNE den `DO`-Idempotenz-Mantel.
 *
 * Der Mantel unten prüft auf den festen Constraint-Namen; er ist für die
 * Laufzeit richtig, macht das Statement für den Drift-Wächter aber unbrauchbar
 * (der biegt Tabelle UND Namen auf eine Probe um — die `IF NOT EXISTS`-Abfrage
 * würde weiter den ECHTEN Namen sehen, ihn auf der realen Tabelle finden und
 * das Anlegen der Probe still überspringen). Deshalb ist das nackte
 * `ALTER TABLE … ADD CONSTRAINT` die SSoT und der Mantel wird daraus gebaut.
 *
 * Der Name steht hier BEWUSST literal statt als `${…}`-Interpolation: der
 * CHECK-Coverage-Scan im Drift-Wächter liest Quelltext und erkennt nur einen
 * literalen Bezeichner nach `ADD CONSTRAINT`. Mit Interpolation wäre dieser
 * Constraint für den Scan unsichtbar — er könnte später aus CHECK_SOURCES
 * fallen, ohne dass etwas rot wird. Ein Test pinnt, dass Name und SQL
 * zusammenpassen.
 */
export const QONTO_MATCH_XOR_CHECK_SQL = `ALTER TABLE qonto_transactions
         ADD CONSTRAINT qonto_transactions_match_xor
         CHECK (NOT (matched_invoice_id IS NOT NULL AND matched_payment_advice_id IS NOT NULL))`;

export const QONTO_ADVICE_MATCH_DDL: string[] = [
  QONTO_MATCHED_ADVICE_ID_COLUMN_SQL,
  QONTO_ADVICE_DISMISSED_AT_COLUMN_SQL,
  QONTO_MATCHED_ADVICE_UNIQUE_INDEX_SQL,
  QONTO_MATCHED_ADVICE_INDEX_SQL,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = '${QONTO_MATCH_XOR_CHECK_NAME}'
     ) THEN
       ${QONTO_MATCH_XOR_CHECK_SQL};
     END IF;
   END $$`,
];

export async function ensureQontoAdviceMatchSchema(): Promise<void> {
  for (const ddl of QONTO_ADVICE_MATCH_DDL) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err) {
      log(`ensureQontoAdviceMatchSchema: ${err}`, "startup");
    }
  }
}
