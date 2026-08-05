/**
 * Setzt das Sicherheitsnetz (`idle_in_transaction_session_timeout`) auf der
 * CI-Test-Datenbank. Werte und Begründung: `scripts/lib/test-db-timeouts.ts`.
 *
 * NUR FÜR DEN CI-`tests`-JOB. Gegenstück zu `applyTestDbTimeouts()` im
 * Orchestrator, der die geklonten Per-Worker-DBs versorgt.
 *
 * WARUM STRIKT CI-ONLY — und nicht „jede DB mit `cc_test_`-Präfix":
 *
 * Der Orchestrator nutzt `DATABASE_URL` als ADMIN-Verbindung, und lokal ist das
 * eine `cc_test_`-DB. Ein Präfix-Guard hätte dieses Skript also ausgerechnet auf
 * die Datenbank losgelassen, auf der seine langlebigen psql-Sessions für den
 * Cache-Build- und den Worker-Slot-Lock liegen. Deshalb: `CI=true` UND der
 * DB-Name des CI-Postgres-Service. Beides muss zutreffen.
 *
 * NICHT in einen Job einbauen, der den ORCHESTRATOR fährt (z.B.
 * `crash-recovery-smoke.yml`) — dort ist `DATABASE_URL` wieder die
 * Admin-Verbindung, und der Guard unten bemerkt das nicht, weil dort ebenfalls
 * `CI=true` und derselbe DB-Name gelten.
 */
import pg from "pg";
import { testDbTimeoutStatements } from "./lib/test-db-timeouts.ts";

/** DB-Name des Postgres-Service im CI-`tests`-Job (`.github/workflows/ci.yml`). */
const CI_SERVICE_DB_NAME = "careconnect";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[test-db-timeouts] FEHLER: DATABASE_URL nicht gesetzt.");
    process.exit(1);
  }

  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!dbName) {
    console.error("[test-db-timeouts] FEHLER: kein Datenbankname in DATABASE_URL.");
    process.exit(1);
  }

  if (process.env.CI !== "true" || dbName !== CI_SERVICE_DB_NAME) {
    console.error(
      `[test-db-timeouts] ABBRUCH: läuft nur im CI-tests-Job (CI=true UND ` +
        `Datenbank '${CI_SERVICE_DB_NAME}'), hier: CI=${process.env.CI ?? "<unset>"}, ` +
        `Datenbank='${dbName}'.\n` +
        "  Lokal setzt der Orchestrator das Netz selbst auf den Per-Worker-DBs.\n" +
        "  Es gehört NICHT auf seine Admin-DB (dort warten Cache-Build- und\n" +
        "  Worker-Slot-Lock) und nicht auf eine echte Datenbank.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const stmt of testDbTimeoutStatements(dbName)) {
      await client.query(stmt);
      console.log(`[test-db-timeouts] ${stmt}`);
    }
    console.log(
      `[test-db-timeouts] gesetzt auf '${dbName}' — greift erst für NEUE ` +
        "Verbindungen, der App-Server muss danach starten.",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[test-db-timeouts] FEHLER:", err);
  process.exit(1);
});
