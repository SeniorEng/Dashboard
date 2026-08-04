/**
 * SSoT für das Sicherheitsnetz gegen stumme Hänger in den TEST-Datenbanken.
 *
 * GESETZT WIRD GENAU EINS: `idle_in_transaction_session_timeout`.
 *
 * Es trifft die WURZEL des beobachteten Hängers. Der CI-`tests`-Job fährt die
 * Integrationstests seriell gegen eine geteilte DB; blockiert ein Request auf
 * einem Advisory-Lock, wartet er unbegrenzt, weil keines der Postgres-Timeouts
 * gesetzt ist. Der Wartende ist dabei nie das Problem — Ursache ist immer eine
 * TRANSAKTION, DIE OFFEN IST UND NICHTS TUT: sie hält den Lock (bzw. die
 * Zeilensperre) bis in alle Ewigkeit, weil `pg_advisory_xact_lock` erst bei
 * Commit oder Rollback freigibt. Genau diese Transaktion beendet
 * `idle_in_transaction_session_timeout` — und der Wartende läuft danach von
 * selbst weiter.
 *
 * 60 Sekunden sind bewusst grosszügig: der Vitest-`testTimeout` für
 * Integrationstests liegt bei 60s, eine legitime Transaktion ist also längst
 * fertig oder der Test bereits rot. Wer 60s LANG UNTÄTIG in einer offenen
 * Transaktion hängt, ist ein Leak, keine Arbeit.
 *
 * WARUM KEIN `lock_timeout` (bewusst verworfen, nicht vergessen):
 *
 * `lock_timeout` gilt auch für `pg_advisory_lock`/`pg_advisory_xact_lock` — es
 * bricht also genau die Wartezeiten ab, die hier ERWÜNSCHT sind:
 *   - Der Billing-Pfad serialisiert absichtlich pro Kunde
 *     (`invoice-data.ts`), pro Rechnungsnummern-Jahr (`billing-storage.ts`) und
 *     pro Budget-Topf (`consumption-engine.ts`). Ein zweiter Lauf SOLL warten;
 *     `tests/billing/invoice-number-concurrency.test.ts` verlangt genau das.
 *   - Der Orchestrator wartet in `acquireCacheBuildLock()` konstruktionsgemäss
 *     bis zu 180 Sekunden auf einen Advisory-Lock, während ein Schwester-Lauf
 *     den Template-Cache baut.
 *   - Die Startup-DDL ist per Architektur-Vorgabe in try/catch gekapselt
 *     (`tests/architecture/startup-steps-fault-isolated.test.ts`). Ein
 *     Lock-Timeout dort würde GESCHLUCKT — der Fix bliebe aus, der Folgefehler
 *     erschiene später in einem unbeteiligten Test. Also genau der stille
 *     Fehlschlag, den dieses Netz abschaffen soll.
 *
 * Einen Wartenden OHNE Blockierer kann es ohnehin nicht geben: verschwindet die
 * offene Transaktion, verschwindet die Wartezeit. `lock_timeout` würde also
 * Risiko einkaufen, ohne diagnostischen Wert hinzuzufügen.
 *
 * KEIN `statement_timeout`: ein legitimer Request darf lange rechnen
 * (PDF-Batch, Startup-Hooks). Der gesuchte Hänger ist ein Sperr-, kein
 * Rechenproblem.
 *
 * PROD BLEIBT UNVERÄNDERT — `server/lib/db.ts` wird nicht angefasst. Gesetzt
 * wird auf DATENBANK-Ebene (`ALTER DATABASE ... SET`): so gilt es für jede
 * Session unabhängig vom Treiber (App über den Neon-WS-Proxy, `drizzle-kit`
 * über direkt-TCP, `psql` im Skript).
 *
 * ZWEI FALLEN:
 *  - `CREATE DATABASE ... TEMPLATE` kopiert Datenbank-Einstellungen NICHT mit
 *    (sie liegen in `pg_db_role_setting`). Jede geklonte Wegwerf-DB muss die
 *    Werte selbst gesetzt bekommen.
 *  - NIEMALS auf die DB setzen, die der Orchestrator als ADMIN-Verbindung nutzt
 *    (`DATABASE_URL` beim Orchestrator-Aufruf). Dort laufen seine langlebigen
 *    psql-Sessions für Cache-Build- und Worker-Slot-Lock.
 */

/** Obergrenze für eine Transaktion, die offen ist und NICHTS tut (Leak-Fänger). */
export const TEST_IDLE_IN_TRANSACTION_TIMEOUT = "60s";

/**
 * `ALTER DATABASE`-Statements für eine Test-DB. Als Liste, damit ein künftiger
 * zweiter Parameter die Aufrufer nicht ändert (`ALTER DATABASE ... SET` setzt
 * immer nur einen).
 */
export function testDbTimeoutStatements(dbName: string): string[] {
  const quoted = `"${dbName.replace(/"/g, '""')}"`;
  return [
    `ALTER DATABASE ${quoted} SET idle_in_transaction_session_timeout = '${TEST_IDLE_IN_TRANSACTION_TIMEOUT}'`,
  ];
}
