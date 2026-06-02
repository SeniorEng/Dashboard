// ---------------------------------------------------------------------------
// Sweep für verwaiste Wegwerf-Test-DBs (Task #902)
//
// Jeder Integration/e2e-Lauf legt über `scripts/with-ephemeral-db.ts` eigene
// Wegwerf-DBs mit Präfix `cc_test_` an und droppt sie beim Teardown wieder —
// auch im normalen Fehlerfall. Wird ein Lauf aber HART abgebrochen (SIGKILL,
// Container-Crash, IDE killt den Prozess), läuft der Teardown nie und die DB
// bleibt verwaist im Postgres-Instanz zurück. Über viele Läufe sammeln sich
// diese Waisen an.
//
// Dieses Modul ist die EINE Quelle der Sweep-Logik. Sie wird sowohl beim
// Orchestrator-Start (vor dem Anlegen der neuen Lauf-DB) als auch vom
// Standalone-CLI `scripts/sweep-test-dbs.ts` verwendet.
//
// SICHERHEIT:
//   - arbeitet AUSSCHLIESSLICH auf Datenbanken mit dem Präfix `cc_test_`.
//   - droppt NUR DBs OHNE aktive Verbindungen (eine laufende Suite hält ihre DB
//     verbunden → wird nie angefasst).
//   - zusätzlich Mindestalter-Guard (`ORPHAN_MIN_AGE_MS`), damit ein parallel
//     laufender Schwester-Lauf seine frisch provisionierte DB nicht im kurzen
//     Provisioning-Fenster (Seeds disconnected, Server noch nicht verbunden)
//     verliert.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";

export const DB_PREFIX = "cc_test_";

// Mindestalter (ms), ab dem eine verbindungslose Wegwerf-DB als „verwaist" gilt.
export const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

export function psql(connUrl: string, sql: string): { ok: boolean; stdout: string } {
  const res = spawnSync("psql", [connUrl, "-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    return { ok: false, stdout: err };
  }
  return { ok: true, stdout: (res.stdout || "").trim() };
}

// Parst den base36-Zeitstempel aus `cc_test_<ts36>_<pid>_<hex>...`. Liefert null
// für Alt-Namen ohne Zeitstempel (die werden konservativ NICHT angefasst).
export function parseDbCreatedAt(name: string): number | null {
  if (!name.startsWith(DB_PREFIX)) return null;
  const rest = name.slice(DB_PREFIX.length);
  const ts36 = rest.split("_")[0];
  if (!ts36 || !/^[0-9a-z]+$/.test(ts36)) return null;
  const ms = parseInt(ts36, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Reine Entscheidungsfunktion: Soll diese verbindungslose Wegwerf-DB gedroppt
// werden? Nur `cc_test_`-DBs mit parsebarem Zeitstempel, die älter als
// `minAgeMs` sind. (`minAgeMs <= 0` => Altersgrenze deaktiviert, z.B. beim
// manuellen Force-Sweep.)
export function shouldDropOrphan(name: string, now: number, minAgeMs: number): boolean {
  if (!name.startsWith(DB_PREFIX)) return false;
  if (minAgeMs <= 0) return true;
  const createdAt = parseDbCreatedAt(name);
  if (createdAt == null) return false;
  return now - createdAt >= minAgeMs;
}

export interface SweepOptions {
  /** Mindestalter in ms; <= 0 deaktiviert die Altersgrenze. Default ORPHAN_MIN_AGE_MS. */
  minAgeMs?: number;
  /** Nur ausgeben, was gedroppt würde, ohne wirklich zu droppen. */
  dryRun?: boolean;
  /** Logger (Default: leise / no-op). */
  log?: (msg: string) => void;
}

export interface SweepResult {
  dropped: string[];
  skipped: string[];
  failed: string[];
}

// Verwaiste Wegwerf-DBs früherer (abgestürzter) Läufe aufräumen — NUR solche
// OHNE aktive Verbindungen UND (sofern Altersgrenze aktiv) älter als minAgeMs.
export function sweepOrphans(adminUrl: string, opts: SweepOptions = {}): SweepResult {
  const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const log = opts.log ?? (() => {});
  const result: SweepResult = { dropped: [], skipped: [], failed: [] };

  const list = psql(
    adminUrl,
    `SELECT datname FROM pg_database d WHERE datname LIKE '${DB_PREFIX}%' ` +
      `AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
  );
  if (!list.ok) {
    log(`[sweep] Konnte DB-Liste nicht ermitteln: ${list.stdout}`);
    return result;
  }
  if (!list.stdout) return result;

  const now = Date.now();
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!shouldDropOrphan(name, now, minAgeMs)) {
      result.skipped.push(name);
      continue;
    }
    if (opts.dryRun) {
      log(`[sweep] (dry-run) würde droppen: ${name}`);
      result.dropped.push(name);
      continue;
    }
    const dropped = psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    if (dropped.ok) {
      log(`[sweep] verwaiste Test-DB gedroppt: ${name}`);
      result.dropped.push(name);
    } else {
      log(`[sweep] Konnte ${name} nicht droppen: ${dropped.stdout}`);
      result.failed.push(name);
    }
  }
  return result;
}
