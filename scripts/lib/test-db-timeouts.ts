/**
 * SSoT für die Sicherheitsnetz-Timeouts der TEST-Datenbanken.
 *
 * WARUM NUR TEST, NICHT PROD:
 *
 * `lock_timeout` gehört bewusst NICHT in die Prod-Verbindung. Der Billing-Pfad
 * serialisiert absichtlich über `pg_advisory_xact_lock` — pro Kunde
 * (`invoice-data.ts`), pro Rechnungsnummern-Jahr (`billing-storage.ts`) und pro
 * Budget-Topf (`consumption-engine.ts`). Ein legitimer Wartender ist dort das
 * ERWÜNSCHTE Verhalten: er soll blockieren, bis der Vorgänger committet hat.
 * Ein `lock_timeout` würde daraus einen Fehler machen und einen korrekt
 * serialisierten Rechnungslauf abbrechen — auf echten Abrechnungsdaten.
 *
 * In der Testumgebung ist die Lage umgekehrt: dort gibt es keine legitime
 * Wartezeit von 15 Sekunden. Alles, was so lange auf einer Sperre steht, ist
 * ein Hänger — und ohne Timeout wartet er unbegrenzt, weil weder
 * `statement_timeout` noch `lock_timeout` noch
 * `idle_in_transaction_session_timeout` irgendwo gesetzt sind. Der Lauf bleibt
 * dann ohne Fehlermeldung stehen, bis das 40-Minuten-Job-Limit greift; im Log
 * steht nichts als der letzte erfolgreiche Request.
 *
 * Diese Werte MACHEN NICHTS SCHNELLER und beheben keine Ursache. Sie
 * verwandeln einen stummen Hänger in einen lauten, lokalisierbaren Fehler
 * (`canceling statement due to lock timeout` bzw. `idle-in-transaction timeout`)
 * mit Stacktrace auf den verursachenden Request.
 *
 * BEWUSST OHNE `statement_timeout`: ein einzelner legitimer Test-Request darf
 * lange laufen (PDF-Batch, Migrations-Hooks beim Boot). Der Hänger, den wir
 * fangen wollen, ist ein SPERR-Problem, kein Rechen-Problem.
 *
 * Gesetzt wird auf DATENBANK-Ebene (`ALTER DATABASE ... SET`), nicht in der
 * Verbindung: so gilt es für jede Session unabhängig vom Treiber — App-Server
 * über den Neon-WS-Proxy, `drizzle-kit` über direkt-TCP, `psql` im Skript —
 * und `server/lib/db.ts` bleibt unverändert.
 *
 * ACHTUNG: `CREATE DATABASE ... TEMPLATE` kopiert Datenbank-Einstellungen NICHT
 * mit (sie liegen in `pg_db_role_setting`, nicht im Template). Jede geklonte
 * Wegwerf-DB muss die Werte deshalb selbst gesetzt bekommen.
 */

/** Obergrenze für das Warten auf eine Sperre. Grosszügig — nur Hänger sollen fallen. */
export const TEST_LOCK_TIMEOUT = "15s";

/** Obergrenze für eine Transaktion, die offen ist und NICHTS tut (Leak-Fänger). */
export const TEST_IDLE_IN_TRANSACTION_TIMEOUT = "60s";

/**
 * `ALTER DATABASE`-Statements für eine Test-DB. Getrennte Statements, weil
 * `ALTER DATABASE ... SET` immer nur einen Parameter setzt.
 */
export function testDbTimeoutStatements(dbName: string): string[] {
  const quoted = `"${dbName.replace(/"/g, '""')}"`;
  return [
    `ALTER DATABASE ${quoted} SET lock_timeout = '${TEST_LOCK_TIMEOUT}'`,
    `ALTER DATABASE ${quoted} SET idle_in_transaction_session_timeout = '${TEST_IDLE_IN_TRANSACTION_TIMEOUT}'`,
  ];
}

/** Dieselben Statements als ein `psql`-taugliches Skript. */
export function testDbTimeoutSql(dbName: string): string {
  return testDbTimeoutStatements(dbName).map((s) => `${s};`).join("\n");
}
