// ---------------------------------------------------------------------------
// Sweep für verwaiste Wegwerf-Test-DBs (Task #902) und deren Server-Logs (#904)
//
// Jeder Integration/e2e-Lauf legt über `scripts/with-ephemeral-db.ts` eigene
// Wegwerf-DBs mit Präfix `cc_test_` an und droppt sie beim Teardown wieder —
// auch im normalen Fehlerfall. Wird ein Lauf aber HART abgebrochen (SIGKILL,
// Container-Crash, IDE killt den Prozess), läuft der Teardown nie und die DB
// bleibt verwaist im Postgres-Instanz zurück. Über viele Läufe sammeln sich
// diese Waisen an.
//
// Dasselbe gilt für die per-Worker-Server-Logs unter `.local/test-server-<port>.log`:
// Jeder Worker schreibt im normalen Lauf eine eigene Log-Datei. Beim Hard-Kill
// läuft kein Teardown → die Logs bleiben liegen und sammeln sich an. Der
// DB-Orphan-Sweep fasst sie nicht an, daher gibt es hier einen parallelen
// Log-Sweep (`sweepOrphanLogs`).
//
// Dieses Modul ist die EINE Quelle der Sweep-Logik. Sie wird sowohl beim
// Orchestrator-Start (vor dem Anlegen der neuen Lauf-DB) als auch vom
// Standalone-CLI `scripts/sweep-test-dbs.ts` verwendet.
//
// SICHERHEIT:
//   - DB-Sweep arbeitet AUSSCHLIESSLICH auf Datenbanken mit dem Präfix `cc_test_`
//     und droppt NUR DBs OHNE aktive Verbindungen (eine laufende Suite hält ihre
//     DB verbunden → wird nie angefasst).
//   - Log-Sweep arbeitet AUSSCHLIESSLICH auf Dateien, die exakt dem Muster
//     `test-server-<port>.log` entsprechen.
//   - zusätzlich Mindestalter-Guard (`ORPHAN_MIN_AGE_MS`), damit ein parallel
//     laufender Schwester-Lauf seine frisch provisionierte DB/sein frisch
//     beschriebenes Log nicht verliert (DB: kurzes Provisioning-Fenster mit
//     disconnecteten Seeds; Log: aktiver Lauf schreibt fortlaufend → frische
//     mtime → geschützt).
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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
// manuellen Force-Sweep.) `protectedDbs` (z.B. die langlebige Cache-Template-DB
// aus Task #907) werden NIE gedroppt — auch nicht im Force-Modus.
export function shouldDropOrphan(
  name: string,
  now: number,
  minAgeMs: number,
  protectedDbs?: ReadonlySet<string>,
): boolean {
  if (!name.startsWith(DB_PREFIX)) return false;
  if (protectedDbs?.has(name)) return false;
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
  /** DB-Namen, die NIE gedroppt werden dürfen (z.B. die Cache-Template-DB). */
  protectedDbs?: ReadonlySet<string>;
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
    if (!shouldDropOrphan(name, now, minAgeMs, opts.protectedDbs)) {
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

// ---------------------------------------------------------------------------
// Log-Sweep: verwaiste per-Worker-Server-Logs `.local/test-server-<port>.log`
// (Task #904)
// ---------------------------------------------------------------------------

// Verzeichnis, in das `with-ephemeral-db.ts` die per-Worker-Server-Logs schreibt.
export const TEST_SERVER_LOG_DIR = ".local";

// Wie viele der jüngsten (zuletzt geschriebenen) Logs IMMER behalten werden —
// auch wenn sie älter als die Altersgrenze sind, damit für ein Post-Mortem des
// letzten Laufs immer Logs greifbar bleiben.
export const LOG_RETENTION_KEEP_RECENT = 4;

// Nur exakt `test-server-<port>.log` matchen — nichts anderes wird je angefasst.
const TEST_SERVER_LOG_RE = /^test-server-\d+\.log$/;

export function isTestServerLogName(name: string): boolean {
  return TEST_SERVER_LOG_RE.test(name);
}

export interface LogFileInfo {
  name: string;
  /** Letzte-Änderungs-Zeit in ms (Date.now()-kompatibel). */
  mtimeMs: number;
}

// Reine Entscheidungsfunktion: Welche Logs sollen gelöscht werden? Die
// `keepRecent` jüngsten Dateien werden IMMER behalten; vom Rest werden nur die
// gelöscht, deren letzter Schreibzugriff mindestens `minAgeMs` zurückliegt (ein
// aktiver Schwester-Lauf schreibt fortlaufend → frische mtime → geschützt).
// `minAgeMs <= 0` deaktiviert die Altersgrenze (Force-Sweep).
export function selectOrphanLogsToDelete(
  files: LogFileInfo[],
  now: number,
  minAgeMs: number,
  keepRecent: number,
): string[] {
  const candidates = files
    .filter((f) => isTestServerLogName(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = Math.max(0, keepRecent);
  return candidates
    .slice(keep)
    .filter((f) => minAgeMs <= 0 || now - f.mtimeMs >= minAgeMs)
    .map((f) => f.name);
}

export interface LogSweepOptions extends SweepOptions {
  /** Verzeichnis mit den Logs (Default TEST_SERVER_LOG_DIR). */
  dir?: string;
  /** Wie viele jüngste Logs immer behalten (Default LOG_RETENTION_KEEP_RECENT). */
  keepRecent?: number;
}

// Verwaiste per-Worker-Server-Logs früherer (hart abgebrochener) Läufe
// aufräumen — analog zum DB-Orphan-Sweep, aber auf Dateiebene.
export function sweepOrphanLogs(opts: LogSweepOptions = {}): SweepResult {
  const dir = opts.dir ?? TEST_SERVER_LOG_DIR;
  const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const keepRecent = opts.keepRecent ?? LOG_RETENTION_KEEP_RECENT;
  const log = opts.log ?? (() => {});
  const result: SweepResult = { dropped: [], skipped: [], failed: [] };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Verzeichnis existiert (noch) nicht → nichts zu tun.
    return result;
  }

  const files: LogFileInfo[] = [];
  for (const name of entries) {
    if (!isTestServerLogName(name)) continue;
    try {
      files.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // Datei verschwand zwischen readdir und stat (Race mit Teardown) → ignorieren.
    }
  }
  if (files.length === 0) return result;

  const now = Date.now();
  const toDelete = new Set(
    selectOrphanLogsToDelete(files, now, minAgeMs, keepRecent),
  );
  for (const { name } of files) {
    if (!toDelete.has(name)) {
      result.skipped.push(name);
      continue;
    }
    if (opts.dryRun) {
      log(`[sweep] (dry-run) würde Log löschen: ${name}`);
      result.dropped.push(name);
      continue;
    }
    try {
      unlinkSync(join(dir, name));
      log(`[sweep] verwaistes Test-Server-Log gelöscht: ${name}`);
      result.dropped.push(name);
    } catch (e) {
      log(`[sweep] Konnte Log ${name} nicht löschen: ${e instanceof Error ? e.message : String(e)}`);
      result.failed.push(name);
    }
  }
  return result;
}
