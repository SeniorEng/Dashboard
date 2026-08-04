/**
 * Setzt die Sicherheitsnetz-Timeouts auf der CI-Test-Datenbank.
 *
 * Gegenstück zu `applyTestDbTimeouts()` im Orchestrator (der die Per-Worker-DBs
 * versorgt) für den ANDEREN Testweg: den CI-`tests`-Job, der gegen EINE geteilte
 * DB fährt. Werte und Begründung stehen an einer Stelle:
 * `scripts/lib/test-db-timeouts.ts`.
 *
 * Fail-closed gegen Fehlbedienung: bricht ab, wenn `DATABASE_URL` auf etwas
 * zeigt, das nicht wie eine Test-DB aussieht. `ALTER DATABASE ... SET` wirkt auf
 * JEDE künftige Session dieser Datenbank — auf einer echten DB wäre das eine
 * stille Verhaltensänderung des Billing-Pfads.
 */
import pg from "pg";
import { testDbTimeoutStatements } from "./lib/test-db-timeouts.ts";

// `cc_test_` ist der Wegwerf-DB-Präfix des Orchestrators und für sich allein
// aussagekräftig. Der nackte CI-Name `careconnect` ist es NICHT — er wäre auch
// ein plausibler Name einer echten Datenbank. Er zählt deshalb nur, wenn
// zusätzlich `CI=true` gesetzt ist (im `tests`-Job explizit gesetzt).
const ALLOWED_PREFIX = "cc_test_";
const CI_ONLY_DB_NAME = "careconnect";

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

  const looksLikeTestDb =
    dbName.startsWith(ALLOWED_PREFIX) ||
    (dbName === CI_ONLY_DB_NAME && process.env.CI === "true");
  if (!looksLikeTestDb) {
    console.error(
      `[test-db-timeouts] ABBRUCH: '${dbName}' sieht nicht nach einer Test-DB aus ` +
        `(erwartet: Präfix '${ALLOWED_PREFIX}', oder '${CI_ONLY_DB_NAME}' mit CI=true). ` +
        "Diese Timeouts gehören NICHT auf eine echte Datenbank — der Billing-Pfad " +
        "serialisiert dort absichtlich über Advisory-Locks.",
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
    const check = await client.query<{ name: string; setting: string }>(
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('lock_timeout', 'idle_in_transaction_session_timeout')
       ORDER BY name`,
    );
    // Sitzungs-Werte der LAUFENDEN Verbindung — die ist vor dem ALTER entstanden
    // und zeigt deshalb noch die alten Werte. Nur zur Information geloggt.
    console.log(
      `[test-db-timeouts] gesetzt auf Datenbank '${dbName}'. ` +
        `(diese Session: ${check.rows.map((r) => `${r.name}=${r.setting}`).join(", ")} — ` +
        "greift erst für neue Verbindungen)",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[test-db-timeouts] FEHLER:", err);
  process.exit(1);
});
