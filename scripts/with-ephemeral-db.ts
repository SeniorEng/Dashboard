// ---------------------------------------------------------------------------
// Ephemeral-Test-DB-Orchestrator (Task #894)
//
// Provisioniert pro Testlauf WEGWERFBARE PostgreSQL-Datenbanken samt frisch
// gestarteten App-Servern und führt das übergebene Test-Kommando dagegen aus.
// Am Ende werden DBs + Server wieder entfernt (auch im Fehlerfall).
//
// ISOLATION & PARALLELITÄT:
//   - Es wird EINE geseedete Template-DB gebaut (Schema-Push + Superadmin +
//     Basis-Referenzdaten), aus der dann pro Worker eine eigene Wegwerf-DB
//     per `CREATE DATABASE ... TEMPLATE` geklont wird (billiger als N× Push).
//   - Für Vitest werden mehrere Worker (Default 2) provisioniert: jeder Worker
//     bekommt seine EIGENE DB + seinen EIGENEN App-Server auf einem frei vom
//     OS vergebenen Port. Vitest verteilt die Integrationsdateien über die
//     Worker (`fileParallelism: true`); innerhalb eines Workers laufen die
//     Dateien sequenziell gegen DESSEN DB → keine Cross-Datei-Kontamination,
//     aber echte Datei-Parallelität über Worker hinweg.
//   - Für Single-Client-Suiten (Playwright) genügt 1 Worker.
//
// Dadurch teilen sich Testläufe KEINEN State mehr:
//   - keine Mutation der Dev-DB durch Tests
//   - keine Cross-Run-Kontamination -> kein Bulk-Purge/Cleanup nötig
//   - kein flock-Mutex nötig (jeder Lauf hat eigene DBs + eigene Server, und
//     dank frei gewählter Ports kollidieren auch zwei GLEICHZEITIGE `test`-
//     Läufe (Auto-Run + Validation) nicht mehr auf einem festen Port)
//   - kein Server-Freshness-Guard (Server werden hier frisch gestartet)
//
// SICHERHEIT: bricht in Production hart ab und arbeitet ausschließlich auf
// Datenbanken mit dem Präfix `cc_test_`. DROP DATABASE läuft nur gegen genau
// diese Wegwerf-DBs.
//
// Aufruf:  tsx scripts/with-ephemeral-db.ts <portHint> <command> [args...]
//   z.B.   tsx scripts/with-ephemeral-db.ts 5050 npx vitest run
//          tsx scripts/with-ephemeral-db.ts 5051 npm run test:e2e:smoke
//   Der <portHint> bleibt aus Kompatibilität erhalten, die tatsächlichen
//   Server-Ports werden aber dynamisch frei vom OS vergeben.
//   Worker-Anzahl: env `EPHEMERAL_DB_WORKERS` (Default: 2 für vitest, sonst 1).
//   (Default bewusst niedrig: das Container-cgroup limitiert pids.max ~1024, und
//   jeder Worker = eigener App-Server; zu viele parallel + Chromium-PDF-Renders +
//   e2e-Browser sprengen das Limit -> `spawn EAGAIN`. 2 = sicherer Parallel-Win.)
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";

const DB_PREFIX = "cc_test_";

function fail(msg: string): never {
  console.error(`[ephemeral-db] ${msg}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const argv = process.argv.slice(2);
const portHint = argv[0];
const command = argv.slice(1);
if (!portHint || !/^\d+$/.test(portHint) || command.length === 0) {
  fail("Usage: tsx scripts/with-ephemeral-db.ts <portHint> <command> [args...]");
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) fail("DATABASE_URL ist nicht gesetzt.");

// Worker-Anzahl: Vitest verteilt Dateien über mehrere DB/Server-Paare; Single-
// Client-Suiten (Playwright) brauchen nur eines.
const isVitest = command.join(" ").includes("vitest");
const workerCount = Math.max(
  1,
  Number(process.env.EPHEMERAL_DB_WORKERS || (isVitest ? "2" : "1")) || 1,
);

const runId = `${Date.now().toString(36)}_${process.pid}_${randomBytes(4).toString("hex")}`;
const templateDb = `${DB_PREFIX}${runId}_tmpl`;
const workerDbs = Array.from({ length: workerCount }, (_, i) => `${DB_PREFIX}${runId}_w${i}`);

function urlForDb(dbName: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${dbName}`;
  return u.toString();
}
const templateUrl = urlForDb(templateDb);

function psql(connUrl: string, sql: string): { ok: boolean; stdout: string } {
  const res = spawnSync("psql", [connUrl, "-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    return { ok: false, stdout: err };
  }
  return { ok: true, stdout: (res.stdout || "").trim() };
}

// Vom OS frei vergebenen TCP-Port ermitteln (bind auf Port 0). Damit kollidieren
// auch zwei GLEICHZEITIGE Orchestrator-Läufe nicht mehr auf einem festen Port.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error("Konnte keinen freien Port ermitteln")));
      }
    });
  });
}

// Mindestalter (ms), ab dem eine verbindungslose Wegwerf-DB als „verwaist" gilt.
// Schützt parallel laufende Schwester-Läufe: deren DB hat während des
// Provisioning-Fensters (Seeds disconnected, Server noch nicht verbunden)
// kurzzeitig KEINE aktiven Verbindungen — ohne Altersgrenze würde ein
// zeitgleicher Sweep sie genau in diesem Fenster löschen.
const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

// Parst den base36-Zeitstempel aus `cc_test_<ts36>_<pid>_<hex>...`. Liefert null
// für Alt-Namen ohne Zeitstempel (die werden konservativ NICHT angefasst).
function parseDbCreatedAt(name: string): number | null {
  const rest = name.slice(DB_PREFIX.length);
  const ts36 = rest.split("_")[0];
  if (!ts36 || !/^[0-9a-z]+$/.test(ts36)) return null;
  const ms = parseInt(ts36, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Verwaiste Wegwerf-DBs früherer (abgestürzter) Läufe aufräumen — aber NUR
// solche OHNE aktive Verbindungen UND älter als ORPHAN_MIN_AGE_MS, damit ein
// parallel laufender Schwester-Lauf seine frisch provisionierte DB nie verliert.
function sweepOrphans(): void {
  const list = psql(
    adminUrl!,
    `SELECT datname FROM pg_database d WHERE datname LIKE '${DB_PREFIX}%' ` +
      `AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
  );
  if (!list.ok || !list.stdout) return;
  const now = Date.now();
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!name.startsWith(DB_PREFIX)) continue;
    const createdAt = parseDbCreatedAt(name);
    if (createdAt == null || now - createdAt < ORPHAN_MIN_AGE_MS) continue;
    psql(adminUrl!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

const serverChildren: ReturnType<typeof spawn>[] = [];
let droppedAlready = false;

function dropAllDbs(): void {
  if (droppedAlready) return;
  droppedAlready = true;
  for (const name of [...workerDbs, templateDb]) {
    const res = psql(adminUrl!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    if (!res.ok) {
      console.warn(`[ephemeral-db] Konnte ${name} nicht löschen: ${res.stdout}`);
    }
  }
}

function killServers(): void {
  for (const child of serverChildren) {
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

function teardown(): void {
  killServers();
  dropAllDbs();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    teardown();
    process.exit(1);
  });
}

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  TEST_USER_PASSWORD:
    process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL,
  // Chromium-Drosselung: Jeder Worker-App-Server rendert PDFs nur 1× gleichzeitig.
  // Bei mehreren Workern (eigener Server je Worker) parallel zu den e2e-Browsern
  // sprengen sonst die addierten Chromium-Threads das cgroup-pids-Limit (~1024)
  // -> `spawn EAGAIN`. Overridebar, falls bewusst höher gefahren werden soll.
  PDF_RENDER_CONCURRENCY: process.env.PDF_RENDER_CONCURRENCY || "1",
};

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const res = spawnSync(cmd, args, { env, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`Befehl fehlgeschlagen (${cmd} ${args.join(" ")}): exit ${res.status}`);
  }
}

// Wartet, bis der Server NICHT NUR antwortet, sondern auch alle Startup-Seeder
// durch sind (Task #894). `runStartupTasks()` läuft fire-and-forget nach
// `listen()`, daher reicht `status: ok` NICHT — sonst rennen die Tests in eine
// Race-Condition, bevor System-Services/Pflegekassen/PKV-Provider geseedet sind.
async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) {
        const body = (await r.json()) as { startupComplete?: boolean };
        if (body.startupComplete === true) return;
        lastErr = new Error("startupComplete=false (Seeder noch nicht durch)");
      } else {
        lastErr = new Error(`HTTP ${r.status}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `App-Server auf ${baseUrl} wurde nicht healthy (${timeoutMs}ms). ` +
      `Letzter Fehler: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

// Task #894 (vom Nutzer bestätigt): Die Wegwerf-DB SOLL die real laufende
// Dev-/Prod-DB spiegeln. Dort fehlt der CHECK-Constraint
// `budget_transactions_appointment_required_check` (die Startup-Migration
// überspringt ihn auf Bestands-DBs mit Alt-Waisen). Auf einer leeren Frisch-DB
// legt derselbe Startup-Hook den Constraint dagegen an — und bricht damit
// Code-Pfade, die ihn auf der Dev-DB NICHT auslösen (km-rebook/reconcile/Storno
// koppeln Alt-Buchungen bewusst per `appointment_id = NULL` ab). Wir droppen ihn
// daher NACH dem Startup und VOR den Tests. Reiner Test-Infra-Eingriff.
function dropMirrorConstraint(dbUrl: string): void {
  const res = psql(
    dbUrl,
    `ALTER TABLE budget_transactions ` +
      `DROP CONSTRAINT IF EXISTS budget_transactions_appointment_required_check`,
  );
  if (!res.ok) {
    console.warn(
      `[ephemeral-db] Konnte budget_transactions_appointment_required_check nicht droppen: ${res.stdout}`,
    );
  }
}

interface WorkerHandle {
  dbName: string;
  dbUrl: string;
  port: number;
  baseUrl: string;
}

async function startWorker(dbName: string): Promise<WorkerHandle> {
  const dbUrl = urlForDb(dbName);

  // Worker-DB aus der geseedeten Template klonen (schnell, kein erneuter Push).
  const cloned = psql(adminUrl!, `CREATE DATABASE "${dbName}" TEMPLATE "${templateDb}"`);
  if (!cloned.ok) {
    throw new Error(`CREATE DATABASE ${dbName} TEMPLATE fehlgeschlagen: ${cloned.stdout}`);
  }

  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  mkdirSync(".local", { recursive: true });
  const logPath = `.local/test-server-${port}.log`;
  const logFd = createWriteStream(logPath, { flags: "w" });
  await new Promise((resolve) => logFd.once("open", resolve));

  console.log(`[ephemeral-db] Starte App-Server (${dbName}) auf Port ${port} (Logs: ${logPath}) ...`);
  const child = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...baseEnv, DATABASE_URL: dbUrl, PORT: String(port) },
    stdio: ["ignore", logFd, logFd],
  });
  serverChildren.push(child);
  child.on("exit", (code, signal) => {
    if (!droppedAlready && code != null && code !== 0) {
      console.error(`[ephemeral-db] App-Server ${dbName} unerwartet beendet (code ${code}, signal ${signal}).`);
    }
  });

  try {
    await waitForHealth(baseUrl, 120_000);
  } catch (e) {
    const tail = spawnSync("tail", ["-n", "60", logPath], { encoding: "utf8" });
    if (tail.stdout) console.error(`[ephemeral-db] Server-Log ${dbName} (tail):\n${tail.stdout}`);
    throw e;
  }

  dropMirrorConstraint(dbUrl);
  return { dbName, dbUrl, port, baseUrl };
}

async function main(): Promise<number> {
  sweepOrphans();

  // 1) Template-DB anlegen, Schema pushen, seeden.
  console.log(`[ephemeral-db] Erstelle Template-DB ${templateDb} ...`);
  const created = psql(adminUrl!, `CREATE DATABASE "${templateDb}"`);
  if (!created.ok) fail(`CREATE DATABASE fehlgeschlagen: ${created.stdout}`);

  const templateEnv: NodeJS.ProcessEnv = { ...baseEnv, DATABASE_URL: templateUrl };
  console.log("[ephemeral-db] Pushe Drizzle-Schema (drizzle-kit push --force) ...");
  run("npx", ["drizzle-kit", "push", "--force"], templateEnv);
  console.log("[ephemeral-db] Seede Test-Superadmin ...");
  run("npx", ["tsx", "scripts/ci-seed-superadmin.ts"], templateEnv);
  // Basis-Stammdaten (Nicht-System-Leistungen hauswirtschaft/alltagsbegleitung
  // inkl. Budget-Töpfen) seeden — die Startup-Hooks legen nur System-Services +
  // Pflegekassen an, viele Tests setzen aber diese zwei Basis-Leistungen voraus.
  console.log("[ephemeral-db] Seede Basis-Referenzdaten (Leistungen) ...");
  run("npx", ["tsx", "scripts/seed-test-reference-data.ts"], templateEnv);

  // Restverbindungen zur Template kappen, damit das Klonen nicht blockiert.
  psql(
    adminUrl!,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = '${templateDb}' AND pid <> pg_backend_pid()`,
  );

  // 2) Worker-DBs aus der Template klonen + je einen App-Server starten (parallel).
  console.log(`[ephemeral-db] Provisioniere ${workerCount} Worker (DB + Server) ...`);
  const handles = await Promise.all(workerDbs.map((db) => startWorker(db)));
  const baseUrls = handles.map((h) => h.baseUrl);

  console.log(
    `[ephemeral-db] ${handles.length} Server healthy. Führe Tests aus: ${command.join(" ")}`,
  );
  const dbUrls = handles.map((h) => h.dbUrl);
  const testEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Direkt-DB-Tests (`import { db } from server/lib/db`) lesen DATABASE_URL beim
    // Import. Default = erste Worker-DB, damit der Vitest-Hauptprozess NIEMALS auf
    // die geerbte Dev-DB zurückfällt; pro Fork überschreibt tests/setup.ts dies
    // auf die DB DESSELBEN Workers, dessen App-Server er via TEST_BASE_URL nutzt
    // (gleicher Index → HTTP-Server und Direkt-DB-Verbindung teilen EINE DB).
    DATABASE_URL: dbUrls[0],
    TEST_DATABASE_URLS: dbUrls.join(","),
    // Erster Server für globalSetup-Health-Probe + Single-Client-Suiten.
    TEST_BASE_URL: baseUrls[0],
    // Vollständige Liste für die Per-Worker-Zuordnung in tests/setup.ts.
    TEST_BASE_URLS: baseUrls.join(","),
    EPHEMERAL_DB_WORKERS: String(workerCount),
    PORT: String(handles[0].port),
  };
  const res = spawnSync(command[0], command.slice(1), { env: testEnv, stdio: "inherit" });
  return res.status ?? 1;
}

main()
  .then((code) => {
    teardown();
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[ephemeral-db] Fehler: ${err instanceof Error ? err.message : String(err)}`);
    teardown();
    process.exit(1);
  });
