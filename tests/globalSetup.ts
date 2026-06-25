import { assertEphemeralTestDb } from "../scripts/lib/ephemeral-db-guard";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

// Task #894: Jeder Integrationslauf bekommt seine eigene wegwerf-DB plus einen
// frisch gestarteten App-Server (siehe `scripts/with-ephemeral-db.ts`).
// Dadurch teilen sich Läufe KEINEN Datenbank-State mehr — der frühere
// Bulk-Purge der stale Test-Daten und der Server-Freshness-Guard
// (`assertServerBuildFresh`) sind damit hinfällig und wurden entfernt.
//
// Es bleibt nur die Health-Probe: In CI startet der App-Server in einem
// separaten Step (vor `vitest run`), daher warten wir hier defensiv, bis
// `/api/health` antwortet, bevor die HTTP-Suiten loslaufen. Lokal hat der
// Orchestrator bereits auf Health gewartet — die Probe ist dann ein No-Op.
//
// Task #894: Wir warten NICHT nur auf `status: ok`, sondern auf
// `startupComplete: true`. `runStartupTasks()` (server/index.ts) läuft
// fire-and-forget NACH `listen()` — auf einer frischen DB (ephemeral oder CI)
// sind die Seeder (System-Services/Pflegekassen/PKV-Provider) sonst noch nicht
// durch, wenn die ersten `beforeAll`-Blöcke Referenzdaten erwarten (Race).
async function waitForServer(): Promise<void> {
  const maxAttempts = 60;
  const delayMs = 1000;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { startupComplete?: boolean };
        if (body.startupComplete === true) return;
        lastError = new Error("startupComplete=false (Seeder noch nicht durch)");
      } else {
        lastError = new Error(`health status ${res.status}`);
      }
    } catch (e) {
      lastError = e;
    }
    if (attempt === 1 || attempt % 5 === 0) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      console.warn(`[globalSetup] Waiting for app server at ${BASE_URL} (attempt ${attempt}/${maxAttempts}): ${msg}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `[globalSetup] App server at ${BASE_URL} did not become healthy after ${maxAttempts}s. ` +
    `Letzter Fehler: ${msg}`,
  );
}

export async function setup() {
  if (process.env.NODE_ENV === "production") {
    console.warn("[globalSetup] Skipping in production environment");
    return;
  }
  // Task #1427: Fail-fast, BEVOR irgendein Integrationstest gegen die DB
  // schreibt. Läuft `vitest run` ohne den Ephemeral-DB-Orchestrator, zeigt die
  // geerbte DATABASE_URL auf die Dev-DB — der Lauf wird hier hart abgebrochen,
  // statt die Dev-DB mit Test-Daten zu fluten.
  assertEphemeralTestDb();
  await waitForServer();
}
