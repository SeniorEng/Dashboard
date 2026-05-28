// ---------------------------------------------------------------------------
// Test-Data-Cleanup-Scheduler (Task #795)
//
// Periodischer Safety-Purge der stale Test-Datensätze. Task #789 hat den
// Backlog (3300+) abgeräumt und das Test-Startup-Cleanup auf einen schnellen
// Bulk-Purge umgestellt — aber der Backlog wächst wieder an, sobald ein
// Testlauf vor seinem per-Suite-`afterAll`-Cleanup abgebrochen wird. Dieser
// Scheduler ruft periodisch die gescopten Purges
// (`runTestDataCleanup` → Kunden/Interessenten/User) auf, sodass die Dev-DB
// nie wieder tausende verwaiste Test-Records ansammelt, statt sich allein auf
// den nächsten `globalSetup` zu verlassen.
//
// SICHERHEIT: läuft NUR in `NODE_ENV === "development"`. In Production wäre ein
// Purge katastrophal; in `test` würde ein Lauf mitten in einer langlaufenden
// Suite die gerade aktiven Test-Fixtures löschen (das Cleanup ist Pattern- und
// nicht altersbasiert) und nichtdeterministische Testfehler verursachen.
// `runTestDataCleanup` ist zusätzlich selbst gegen Production geschützt
// (Defense-in-Depth) — der Strict-Dev-Gate hier ist die eigentliche Grenze.
// ---------------------------------------------------------------------------
import { runTestDataCleanup, type TestDataCleanupSummary } from "./test-data-cleanup";

// Alle 6 Stunden — häufig genug, um Backlog-Wachstum zu verhindern, selten
// genug, um die Dev-DB nicht unnötig zu belasten.
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Erster Lauf 10 Minuten nach Boot — gibt dem Server Zeit, vollständig
// hochzufahren, und kollidiert nicht mit einem evtl. parallel laufenden
// Testlauf direkt nach dem Start.
const INITIAL_DELAY_MS = 10 * 60 * 1000;

function logSummary(summary: TestDataCleanupSummary): void {
  if (summary.skipped) {
    return;
  }
  const total =
    summary.customersDeleted + summary.prospectsDeleted + summary.usersDeleted;
  if (total === 0 && summary.customersFailed === 0 && !summary.usersBlocked) {
    // Idempotenter No-op-Lauf — kurz und leise quittieren.
    console.log("[test-data-cleanup] Periodischer Lauf: keine stale Test-Daten gefunden");
    return;
  }
  console.log(
    `[test-data-cleanup] Periodischer Lauf: ${summary.customersDeleted} Kunden` +
    `${summary.customersFailed > 0 ? ` (${summary.customersFailed} fehlgeschlagen)` : ""}, ` +
    `${summary.prospectsDeleted} Interessenten, ` +
    `${summary.usersDeleted} User` +
    `${summary.usersRejected > 0 ? ` (${summary.usersRejected} abgelehnt)` : ""}` +
    `${summary.usersBlocked ? " — ACHTUNG: ein User-Batch blockiert (echte Kunden-Refs)" : ""} entfernt`,
  );
}

function runOnce(): void {
  runTestDataCleanup()
    .then(logSummary)
    .catch((err) => console.error("[test-data-cleanup] Scheduler-Fehler:", err));
}

export function startTestDataCleanupScheduler(): {
  interval: NodeJS.Timeout | null;
  timeout: NodeJS.Timeout | null;
} {
  if (process.env.NODE_ENV !== "development") {
    console.log(
      `[test-data-cleanup] Scheduler nur in development aktiv (NODE_ENV=${process.env.NODE_ENV ?? "unset"}) — übersprungen`,
    );
    return { interval: null, timeout: null };
  }

  const timeout = setTimeout(runOnce, INITIAL_DELAY_MS);
  const interval = setInterval(runOnce, POLL_INTERVAL_MS);
  console.log(
    `[test-data-cleanup] Scheduler gestartet (erster Lauf in ${Math.round(INITIAL_DELAY_MS / 60000)} min, ` +
    `danach alle ${Math.round(POLL_INTERVAL_MS / 3600000)} h)`,
  );
  return { interval, timeout };
}
