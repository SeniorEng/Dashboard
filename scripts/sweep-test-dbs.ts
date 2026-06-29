// ---------------------------------------------------------------------------
// Standalone-CLI: verwaiste Wegwerf-Test-DBs + Server-Logs + Prozesse aufräumen
// (Task #902/#904/#1489)
//
// Räumt zurückgebliebene `cc_test_%`-Datenbanken, `.local/test-server-<port>.log`-
// Dateien UND verwaiste Test-PROZESSE (App-Server + Chromium-Enkel) auf, die von
// hart abgebrochenen Testläufen (SIGKILL, Container-Crash, IDE killt den Prozess)
// übrig blieben. Dieselbe Sweep-Logik läuft auch automatisch beim Start des
// Orchestrators `scripts/with-ephemeral-db.ts` — dieses CLI ist der manuelle
// „Unblock"-Aufruf (z.B. wenn das cgroup-pids-Limit erschöpft ist und Läufe an
// „spawn EAGAIN" scheitern). Meldet zum Schluss die PID-Auslastung.
//
// SICHERHEIT: arbeitet ausschließlich auf `cc_test_`-DBs OHNE aktive
// Verbindungen (eine laufende Suite hält ihre DB verbunden → unberührt), auf
// Dateien exakt nach Muster `test-server-<port>.log` und auf Prozesse mit
// eindeutigem Test-Marker, die auf init reparentet wurden (PPID===1 → ihr
// Orchestrator ist tot). Per Default greift zusätzlich eine Altersgrenze, damit
// ein parallel laufender Schwester-Lauf seine frischen Ressourcen nicht verliert;
// außerdem werden die jüngsten Logs immer behalten. Niemals der eigene Prozess.
//
// Aufruf:
//   tsx scripts/sweep-test-dbs.ts            # nur verbindungslose, alte (>15min) Waisen
//   tsx scripts/sweep-test-dbs.ts --dry-run  # nur anzeigen, nichts droppen/löschen/killen
//   tsx scripts/sweep-test-dbs.ts --force    # Altersgrenze ignorieren (alle Waisen)
//   tsx scripts/sweep-test-dbs.ts --min-age-ms=0   # gleichbedeutend mit --force
//   npm run test:unblock                     # = --force (PID-Limit-Notfall-Aufräumung)
// ---------------------------------------------------------------------------
import {
  ORPHAN_MIN_AGE_MS,
  evaluatePidPreflight,
  readPidStats,
  sweepOrphanLogs,
  sweepOrphanProcesses,
  sweepOrphans,
} from "./lib/ephemeral-db-sweep.ts";
import { CACHE_DB_NAME } from "./lib/template-cache.ts";

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
  // Die langlebige Cache-Template-DB (Task #907) ist absichtlich verbindungslos
  // und alt — sie darf NIE als Waise gedroppt werden, auch nicht im Force-Modus.
  protectedDbs: new Set([CACHE_DB_NAME]),
});

const logResult = sweepOrphanLogs({
  minAgeMs,
  dryRun,
  log: (m) => console.log(m),
});

// Task #1489: ... und die verwaisten Test-PROZESSE (App-Server + Chromium-Enkel
// aus hart abgebrochenen Läufen) — die eigentlichen PID-Fresser. Dieselbe SSoT-
// Sweep-Logik wie im Orchestrator; hier der manuelle „Unblock"-Aufruf.
const procResult = sweepOrphanProcesses({
  minAgeMs,
  dryRun,
  log: (m) => console.log(m),
});

console.log(
  `[sweep] Fertig. ${dryRun ? "(dry-run) " : ""}` +
    `DBs gedroppt: ${result.dropped.length}, übersprungen: ${result.skipped.length}, ` +
    `fehlgeschlagen: ${result.failed.length}. ` +
    `Logs gelöscht: ${logResult.dropped.length}, übersprungen: ${logResult.skipped.length}, ` +
    `fehlgeschlagen: ${logResult.failed.length}. ` +
    `Prozesse beendet: ${procResult.killed.length}, ` +
    `fehlgeschlagen: ${procResult.failed.length}.`,
);

// Task #1489: PID-Auslastung nach dem Aufräumen melden, damit man sofort sieht,
// ob der Workspace wieder Luft hat (cgroup pids.max). Reine Diagnose-Ausgabe.
const pidStats = readPidStats();
if (pidStats.max != null) {
  const pre = evaluatePidPreflight(pidStats, 0.8);
  console.log(
    `[sweep] PID-Auslastung: ${pidStats.current}/${pidStats.max} ` +
      `(${((pre.ratio ?? 0) * 100).toFixed(0)}%).` +
      (pre.ok ? "" : " ⚠️ weiterhin hoch — ggf. Workspace neu starten."),
  );
} else {
  console.log("[sweep] PID-Auslastung: nicht ermittelbar (kein cgroup-pids-Limit lesbar).");
}

process.exit(
  result.failed.length + logResult.failed.length + procResult.failed.length > 0 ? 1 : 0,
);
