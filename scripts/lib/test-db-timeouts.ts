/**
 * SSoT für das Sicherheitsnetz gegen stumme Hänger in den TEST-Datenbanken.
 *
 * ERSETZT das 40-Minuten-Job-Timeout als einzigen Fänger für einen stummen
 * Hänger: bisher lief der CI-`tests`-Job in die Zeitüberschreitung, und der
 * eigentliche Fehlschlag war aus dem Abbruch nicht mehr ablesbar.
 *
 * GESETZT WIRD GENAU EINS: `idle_in_transaction_session_timeout`.
 *
 * Es trifft die WURZEL des beobachteten Hängers. Der CI-`tests`-Job fährt die
 * Integrationstests seriell gegen eine geteilte DB; blockiert ein Request auf
 * einem Advisory-Lock, wartet er unbegrenzt, weil keines der Postgres-Timeouts
 * gesetzt ist. Der Wartende ist dabei nie das Problem — in den BLOCKIERENDEN
 * Lock-Pfaden dieser App (durchweg `pg_advisory_xact_lock`) ist die Ursache
 * eine TRANSAKTION, DIE OFFEN IST UND NICHTS TUT: sie hält den Lock (bzw. die
 * Zeilensperre) bis in alle Ewigkeit, weil ein Xact-Lock erst bei Commit oder
 * Rollback freigibt. Genau diese Transaktion beendet
 * `idle_in_transaction_session_timeout` — und der Wartende läuft danach von
 * selbst weiter.
 *
 * Bewusst NICHT abgedeckt: ein SESSION-scoped `pg_advisory_lock` ausserhalb
 * jeder Transaktion. Sein Halter ist `idle`, nicht `idle in transaction`, und
 * dieser Parameter fasst ihn nie an. Im Repo ist das folgenlos, weil alle
 * Session-Lock-Stellen (`qonto-backfill-runner`, Chromium-Pre-Warm, die
 * psql-Sessions des Orchestrators) `pg_try_advisory_lock` nutzen, also
 * nicht-blockierend sind. Fiele diese Eigenschaft, deckt das Netz den Fall
 * nicht ab — dann wäre `idle_session_timeout` die passende Schraube, nicht
 * `lock_timeout`.
 *
 * WARUM 180s UND NICHT 60s — der Wert MUSS über dem Vitest-Timeout liegen:
 *
 * Das Auslösen dieses Timeouts ist NICHT folgenlos. Postgres schickt den FATAL,
 * während keine Query aktiv ist; ein vom Pool AUSGECHECKTER Client hat in dem
 * Moment keinen `error`-Listener (`pool.on("error")` in `server/lib/db.ts`
 * greift nur für IDLE-Clients). Das Ergebnis ist eine `uncaughtException` —
 * und die läuft in `server/index.ts` in `gracefulShutdown`. Nachgemessen:
 *
 *   >>> uncaughtException: terminating connection due to idle-in-transaction timeout
 *   >>> pool.on('error'): (nie aufgerufen)
 *
 * Im CI-`tests`-Job hängt ein EINZIGER langlebiger App-Server am ganzen Lauf.
 * Ein verfrühtes Auslösen nimmt also nicht einen Test mit, sondern alle
 * nachfolgenden Dateien — das Gegenteil dessen, was dieses Netz erreichen soll.
 *
 * Bei 60s stand der Wert exakt auf dem `testTimeout` für Integrationstests
 * (`vitest.config.ts`) und konnte damit GLEICHZEITIG mit dem Test-Timeout
 * feuern. 180s liegen klar darüber: der Test ist längst rot abgebrochen und hat
 * seine Verbindung zurückgegeben, bevor das Netz überhaupt greifen kann. Als
 * Leak-Fänger bleibt es voll wirksam — die Alternative ist nicht „60s", sondern
 * das 40-Minuten-Job-Timeout.
 *
 * Wer 3 Minuten UNTÄTIG in einer offenen Transaktion hängt, ist ein Leak, keine
 * Arbeit. Eine reale Gegenprobe: die Kundenanlage hält ihre Transaktion bewusst
 * über eine Puppeteer-PDF-Generierung offen
 * (`server/lib/customer-creation-helpers.ts`) — für Postgres ist das „idle in
 * transaction", und der Render ist nach oben nicht bei 60s gedeckelt
 * (bis zu 5 Versuche à 30s plus ungedeckeltes Warten auf einen Render-Slot).
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
 *
 *    Zur Genauigkeit: GENAU DIESER Parameter würde sie nicht töten — die
 *    psql-Sessions setzen kein `BEGIN`, sind also `idle` und nicht `idle in
 *    transaction`. Die Regel gilt trotzdem unverändert, denn sie schützt die
 *    Absicht: auf der Admin-DB hat ein Test-Sicherheitsnetz nichts verloren,
 *    und der nächstliegende Nachbarparameter (`idle_session_timeout`) würde
 *    genau diese Sessions abräumen. Deshalb ist der Guard hart, nicht
 *    parameterabhängig.
 */

/**
 * Obergrenze für eine Transaktion, die offen ist und NICHTS tut (Leak-Fänger).
 * MUSS über dem Vitest-`testTimeout` (60s) liegen — Begründung im Datei-Kopf.
 */
export const TEST_IDLE_IN_TRANSACTION_TIMEOUT = "180s";

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
