// ---------------------------------------------------------------------------
// Standalone-CLI: verwaiste Wegwerf-Test-DBs aufräumen (Task #902)
//
// Räumt zurückgebliebene `cc_test_%`-Datenbanken auf, die von hart abgebrochenen
// Testläufen (SIGKILL, Container-Crash, IDE killt den Prozess) übrig blieben.
// Dieselbe Sweep-Logik läuft auch automatisch beim Start des Orchestrators
// `scripts/with-ephemeral-db.ts` — dieses CLI ist der manuelle Aufruf.
//
// SICHERHEIT: arbeitet ausschließlich auf `cc_test_`-DBs OHNE aktive
// Verbindungen (eine laufende Suite hält ihre DB verbunden → unberührt). Per
// Default greift zusätzlich eine 15-Minuten-Altersgrenze, damit ein parallel
// laufender Schwester-Lauf seine frisch provisionierte DB nicht verliert.
//
// Aufruf:
//   tsx scripts/sweep-test-dbs.ts            # nur verbindungslose, alte (>15min) Waisen
//   tsx scripts/sweep-test-dbs.ts --dry-run  # nur anzeigen, nichts droppen
//   tsx scripts/sweep-test-dbs.ts --force    # Altersgrenze ignorieren (alle verbindungslosen Waisen)
//   tsx scripts/sweep-test-dbs.ts --min-age-ms=0   # gleichbedeutend mit --force
// ---------------------------------------------------------------------------
import { ORPHAN_MIN_AGE_MS, sweepOrphans } from "./lib/ephemeral-db-sweep.ts";

function fail(msg: string): never {
  console.error(`[sweep] ${msg}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) fail("DATABASE_URL ist nicht gesetzt.");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const minAgeArg = argv.find((a) => a.startsWith("--min-age-ms="));
let minAgeMs = force ? 0 : ORPHAN_MIN_AGE_MS;
if (minAgeArg) {
  const parsed = Number(minAgeArg.split("=")[1]);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`Ungültiges --min-age-ms: ${minAgeArg}`);
  minAgeMs = parsed;
}

const result = sweepOrphans(adminUrl, {
  minAgeMs,
  dryRun,
  log: (m) => console.log(m),
});

console.log(
  `[sweep] Fertig. ${dryRun ? "(dry-run) " : ""}` +
    `gedroppt: ${result.dropped.length}, übersprungen: ${result.skipped.length}, ` +
    `fehlgeschlagen: ${result.failed.length}.`,
);

process.exit(result.failed.length > 0 ? 1 : 0);
