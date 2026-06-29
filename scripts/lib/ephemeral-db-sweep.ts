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
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Prozess-Sweep: verwaiste Test-App-Server + deren Chromium-Prozesse (Task #1489)
//
// Wird ein Testlauf HART abgebrochen (SIGKILL des Orchestrators, Container-Crash,
// IDE killt den Prozess), läuft der Teardown nie. Die per-Worker gebündelten
// App-Server (`node .local/test-server-<runId>.cjs`) UND die von ihnen für die
// PDF-Generierung gestarteten Chromium-Instanzen bleiben dann als Waisen liegen.
// Sie reparenten auf init (PPID 1) und sammeln sich über viele abgebrochene
// Läufe an, bis das Container-cgroup-Limit (`pids.max` ~1024) gesprengt ist und
// JEDER neue Lauf an `spawn EAGAIN` scheitert. Das ist die Prozess-Dimension
// desselben Waisen-Problems, das der DB-/Log-Sweep oben auf DB-/Datei-Ebene löst.
//
// SICHERHEIT (analog DB-/Log-Sweep):
//   - Nur Prozesse mit einem EINDEUTIGEN Test-Marker werden je angefasst: der
//     gebündelte Test-Server-Pfad `.local/test-server-<id>.cjs` bzw. das
//     test-spezifische Chromium-User-Data-Dir `careconnect-chromium-test-…`
//     (siehe server/services/pdf-generator.ts; Dev/Prod-Chromium trägt diesen
//     Marker NICHT und ist damit per Konstruktion ausgeschlossen).
//   - Waisen-BEWEIS = PPID === 1 (an init reparentet → der spawnende
//     Orchestrator/Server ist tot). Ein PARALLEL laufender Schwester-Lauf hält
//     seine Kinder (PPID = lebender Orchestrator/Server ≠ 1) → wird NIE getötet.
//   - zusätzlich Mindestalter-Guard gegen eine ganz frische Reparent-Race.
//   - der eigene Prozess (selfPid) und init (pid<=1) werden nie angefasst.
//
// FAIL-SAFE: Fehler beim Enumerieren/Killen blockieren NIE den Testlauf; sie
// werden geloggt und übersprungen.
// ---------------------------------------------------------------------------

// Mindestalter (ms), ab dem ein an init reparenteter Test-Prozess als „verwaist"
// gilt. Bewusst kurz: ein echter Orphan lief vor dem Hard-Kill i.d.R. lange
// (Boot + Tests), liegt also weit über dieser Schwelle; die Schwelle schützt nur
// gegen das mikrosekundenkurze Reparent-Fenster. (`minAgeMs <= 0` => deaktiviert,
// z.B. beim manuellen Force-/Unblock-Sweep.)
export const ORPHAN_PROC_MIN_AGE_MS = 30 * 1000;

// Eindeutiger Marker des gebündelten per-Worker-Test-Servers in der Kommandozeile
// (`node .local/test-server-<runId>.cjs`). Der Log-Pfad `.local/test-server-<port>.log`
// taucht NICHT in der Kommandozeile auf (stdio läuft über einen File-Descriptor),
// daher matcht das `.cjs`-Bundle eindeutig genau den Server-Prozess.
const TEST_SERVER_PROC_RE = /\.local\/test-server-[^\s/]+\.cjs/;

// Eindeutiger Marker der test-spezifischen Chromium-User-Data-Dirs (NODE_ENV=test;
// siehe makeChromiumUserDataDir in server/services/pdf-generator.ts). Erscheint in
// der Chromium-Kommandozeile als `--user-data-dir=/tmp/careconnect-chromium-test-…`.
export const TEST_CHROMIUM_PROC_MARKER = "careconnect-chromium-test-";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Vergangene Laufzeit in Sekunden seit Prozessstart (ps `etimes`). */
  etimeSec: number;
  /** Vollständige Kommandozeile (ps `args`). */
  command: string;
}

export interface OrphanProcess {
  pid: number;
  kind: "server" | "chromium";
  command: string;
}

// Reine Klassifikation: Ist das ein vom Test-Harness gestarteter Prozess — und
// wenn ja, welcher? `null` = unbeteiligter Fremdprozess (wird nie angefasst).
export function classifyTestProcess(command: string): "server" | "chromium" | null {
  if (TEST_SERVER_PROC_RE.test(command)) return "server";
  if (command.includes(TEST_CHROMIUM_PROC_MARKER)) return "chromium";
  return null;
}

// Reine Entscheidungsfunktion: Welche Prozesse sind verwaiste Test-Prozesse, die
// gekillt werden dürfen? Nur Marker-Treffer, an init reparentet (PPID 1) und
// (sofern Altersgrenze aktiv) alt genug. Nie der eigene Prozess, nie init.
export function selectOrphanProcesses(
  procs: ProcInfo[],
  selfPid: number,
  minAgeMs: number,
): OrphanProcess[] {
  const minAgeSec = minAgeMs <= 0 ? 0 : minAgeMs / 1000;
  const out: OrphanProcess[] = [];
  for (const p of procs) {
    if (p.pid === selfPid || p.pid <= 1) continue;
    const kind = classifyTestProcess(p.command);
    if (kind == null) continue;
    // Waisen-Beweis: an init reparentet. Ein lebender (Schwester-)Lauf hält seine
    // Kinder → PPID ≠ 1 → geschützt.
    if (p.ppid !== 1) continue;
    if (minAgeMs > 0 && p.etimeSec < minAgeSec) continue;
    out.push({ pid: p.pid, kind, command: p.command });
  }
  return out;
}

// Parst die Ausgabe von `ps -eo pid=,ppid=,etimes=,args=` (reine Funktion).
// Zeilen, die nicht dem Muster entsprechen, werden ignoriert.
export function parsePsOutput(stdout: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      etimeSec: Math.max(0, Number(m[3])),
      command: m[4],
    });
  }
  return procs;
}

// Liest die laufende Prozessliste via `ps`. Liefert bei Fehler [] (fail-safe).
export function enumerateProcesses(): ProcInfo[] {
  try {
    const res = spawnSync("ps", ["-eo", "pid=,ppid=,etimes=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.status !== 0 || !res.stdout) return [];
    return parsePsOutput(res.stdout);
  } catch {
    return [];
  }
}

function isNoSuchProcess(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "ESRCH";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ProcSweepOptions {
  /** Mindestalter in ms; <= 0 deaktiviert die Altersgrenze. Default ORPHAN_PROC_MIN_AGE_MS. */
  minAgeMs?: number;
  /** Nur ausgeben, was gekillt würde, ohne wirklich zu killen. */
  dryRun?: boolean;
  /** Logger (Default: leise / no-op). */
  log?: (msg: string) => void;
  /** Eigener Prozess, der NIE angefasst wird (Default process.pid). */
  selfPid?: number;
  /** Injizierbare Prozessliste (für Tests). Default: enumerateProcesses(). */
  enumerate?: () => ProcInfo[];
  /** Injizierbarer Kill (für Tests). Default: echtes process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ProcSweepResult {
  killed: OrphanProcess[];
  failed: OrphanProcess[];
}

// Verwaiste Test-Prozesse früherer (hart abgebrochener) Läufe killen — analog zum
// DB-/Log-Orphan-Sweep, aber auf Prozessebene. Server zuerst (per Prozessgruppe,
// damit Chromium-Enkel mitsterben), dann ggf. erst durch das Server-Kill auf init
// reparentete Chromium-Waisen im zweiten Durchgang.
export function sweepOrphanProcesses(opts: ProcSweepOptions = {}): ProcSweepResult {
  const minAgeMs = opts.minAgeMs ?? ORPHAN_PROC_MIN_AGE_MS;
  const log = opts.log ?? (() => {});
  const selfPid = opts.selfPid ?? process.pid;
  const enumerate = opts.enumerate ?? enumerateProcesses;
  const killFn = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const result: ProcSweepResult = { killed: [], failed: [] };

  let orphans: OrphanProcess[];
  try {
    orphans = selectOrphanProcesses(enumerate(), selfPid, minAgeMs);
  } catch (e) {
    log(`[sweep] Prozess-Enumeration fehlgeschlagen: ${errMsg(e)}`);
    return result;
  }

  // Server zuerst — ihr Gruppen-Kill nimmt die Chromium-Enkel mit.
  const ordered = [...orphans].sort((a, b) => (a.kind === "server" ? -1 : 1));
  for (const o of ordered) {
    if (opts.dryRun) {
      log(`[sweep] (dry-run) würde verwaisten ${o.kind}-Prozess killen: pid ${o.pid}`);
      result.killed.push(o);
      continue;
    }
    try {
      // Erst die ganze Prozessgruppe (negativ) — fängt Chromium-Enkel eines
      // Servers mit; schlägt das fehl (kein Gruppenführer / schon weg), folgt der
      // Einzel-Kill darunter.
      try {
        killFn(-o.pid, "SIGKILL");
      } catch {
        // kein Gruppenführer → Einzel-Kill genügt.
      }
      killFn(o.pid, "SIGKILL");
      log(`[sweep] verwaisten ${o.kind}-Prozess gekillt: pid ${o.pid}`);
      result.killed.push(o);
    } catch (e) {
      if (isNoSuchProcess(e)) {
        // Schon weg (z.B. durch den Gruppen-Kill) → als Erfolg werten.
        result.killed.push(o);
        continue;
      }
      log(`[sweep] Konnte Prozess ${o.pid} nicht killen: ${errMsg(e)}`);
      result.failed.push(o);
    }
  }

  // Zweiter Durchgang: Chromium-Enkel, die erst durch das Server-Kill auf init
  // reparentet wurden (Alt-Läufe ohne eigene Prozessgruppe).
  if (!opts.dryRun && orphans.some((o) => o.kind === "server")) {
    let second: OrphanProcess[] = [];
    try {
      second = selectOrphanProcesses(enumerate(), selfPid, minAgeMs).filter(
        (o) => o.kind === "chromium" && !result.killed.some((k) => k.pid === o.pid),
      );
    } catch {
      second = [];
    }
    for (const o of second) {
      try {
        killFn(o.pid, "SIGKILL");
        log(`[sweep] verwaisten chromium-Prozess (2. Durchgang) gekillt: pid ${o.pid}`);
        result.killed.push(o);
      } catch (e) {
        if (isNoSuchProcess(e)) {
          result.killed.push(o);
          continue;
        }
        result.failed.push(o);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// PID-Preflight: vor dem Provisionieren prüfen, ob das cgroup-pids-Limit schon
// (fast) ausgeschöpft ist (Task #1489). Läuft NACH dem Orphan-Sweep — der gibt
// erst PIDs frei; bleibt es danach saturiert, ist der Workspace echt ausgelastet
// und der Orchestrator bricht mit einer klaren Anleitung ab, statt mitten im Lauf
// an `spawn EAGAIN` zu zerschellen.
// ---------------------------------------------------------------------------

export interface PidStats {
  /** Aktuell vom cgroup gezählte Prozesse/Threads. */
  current: number;
  /** cgroup-pids-Limit; null = unbegrenzt ("max") / nicht ermittelbar. */
  max: number | null;
}

export interface PidPreflightResult {
  ok: boolean;
  /** current/max; null wenn max unbekannt/unbegrenzt. */
  ratio: number | null;
  current: number;
  max: number | null;
}

// Reine Entscheidung: Liegt die PID-Auslastung unter dem Schwellwert? Ist `max`
// unbekannt/unbegrenzt, gilt der Preflight als bestanden (kein falscher Block).
export function evaluatePidPreflight(stats: PidStats, threshold: number): PidPreflightResult {
  if (stats.max == null || !Number.isFinite(stats.max) || stats.max <= 0) {
    return { ok: true, ratio: null, current: stats.current, max: stats.max };
  }
  const ratio = stats.current / stats.max;
  return { ok: ratio < threshold, ratio, current: stats.current, max: stats.max };
}

function readCgroupFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (raw.length > 0) return raw;
    } catch {
      // nächste Variante (cgroup v2 vs v1) versuchen.
    }
  }
  return null;
}

// Liest die cgroup-PID-Statistik (v2: `/sys/fs/cgroup/pids.{current,max}`,
// v1-Fallback: `/sys/fs/cgroup/pids/pids.{current,max}`). Fail-safe: nicht
// ermittelbare Werte ⇒ current 0 / max null (Preflight besteht dann).
export function readPidStats(): PidStats {
  const currentRaw = readCgroupFirst([
    "/sys/fs/cgroup/pids.current",
    "/sys/fs/cgroup/pids/pids.current",
  ]);
  const maxRaw = readCgroupFirst(["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]);
  let current = 0;
  if (currentRaw != null) {
    const n = Number(currentRaw);
    if (Number.isFinite(n) && n >= 0) current = n;
  }
  let max: number | null = null;
  if (maxRaw != null && maxRaw !== "max") {
    const n = Number(maxRaw);
    if (Number.isFinite(n) && n > 0) max = n;
  }
  return { current, max };
}
