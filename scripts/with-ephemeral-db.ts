// ---------------------------------------------------------------------------
// Ephemeral-Test-DB-Orchestrator (Task #894)
//
// Provisioniert pro Testlauf WEGWERFBARE PostgreSQL-Datenbanken samt frisch
// gestarteten App-Servern und führt das übergebene Test-Kommando dagegen aus.
// Am Ende werden DBs + Server wieder entfernt (auch im Fehlerfall).
//
// ISOLATION & PARALLELITÄT:
//   - Es wird EINE geseedete Per-Lauf-Template-DB bereitgestellt, aus der dann
//     pro Worker eine eigene Wegwerf-DB per `CREATE DATABASE ... TEMPLATE`
//     geklont wird (billiger als N× Push).
//   - Task #907: Die geseedete Vorlage (Schema-Push + Superadmin + Basis-
//     Referenzdaten) wird über Läufe hinweg in einer persistenten Cache-DB
//     `cc_test_tmpl_cache` wiederverwendet, geschlüsselt über einen Hash von
//     `shared/schema/**` + `drizzle.config.ts` + den Seed-Skripten (hinterlegt
//     als `COMMENT ON DATABASE`). Passt der Hash, entfallen Push + Seeds und die
//     Per-Lauf-Template wird direkt aus dem Cache geklont (warme Läufe starten
//     in Sekunden statt ~24s). Ändert sich Schema/Seed, wird der Cache einmalig
//     neu gebaut. Abschaltbar via `EPHEMERAL_DB_CACHE=0`.
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
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve as resolvePath } from "node:path";
import { DB_PREFIX, sweepOrphanLogs, sweepOrphans } from "./lib/ephemeral-db-sweep.ts";
import {
  CACHE_DB_NAME,
  computeTemplateHash,
  isCacheFresh,
} from "./lib/template-cache.ts";
import { buildServerBundle } from "../script/server-bundle";

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

// Task #907: Wiederverwendung der geseedeten Cache-Template-DB über Läufe
// hinweg. Per `EPHEMERAL_DB_CACHE=0` abschaltbar (dann altes Verhalten: Push +
// Seeds frisch pro Lauf direkt in die Per-Lauf-Template).
const cachingEnabled = process.env.EPHEMERAL_DB_CACHE !== "0";

const runId = `${Date.now().toString(36)}_${process.pid}_${randomBytes(4).toString("hex")}`;
const templateDb = `${DB_PREFIX}${runId}_tmpl`;
const workerDbs = Array.from({ length: workerCount }, (_, i) => `${DB_PREFIX}${runId}_w${i}`);

// Task #903/#908: Wir bündeln den Server EINMAL pro Lauf via esbuild (API-only)
// und booten die Worker mit plain `node` statt `tsx`. Das senkt den Boot pro
// Worker von ~13s (tsx-Transpilation) auf ~3s. Das gilt jetzt für BEIDE Pfade:
//   - Vitest (API-only): bootet mit `TEST_SKIP_CLIENT=1` (kein Client nötig).
//   - Playwright/e2e: braucht eine gerenderte SPA. Statt des teuren Vite-Dev-
//     Servers (`tsx server/index.ts` → setupVite) bauen wir den Vite-Client
//     EINMAL pro Lauf vor und liefern ihn statisch aus (`TEST_SERVE_STATIC_CLIENT=1`
//     + `CLIENT_STATIC_DIR`). Das `./vite`-Modul wird nie geladen → das gleiche
//     API-only-Bundle (`excludeClientServer: true`) funktioniert für beide Pfade.
// Per-Lauf-Pfade, damit zwei GLEICHZEITIGE Läufe nicht auf derselben Bundle-/
// Client-Datei kollidieren. Escape-Hatch `EPHEMERAL_DISABLE_BUNDLE=1` fällt auf
// den alten `tsx`-Boot zurück (e2e dann wieder via Vite-Dev-Server).
const useServerBundle = process.env.EPHEMERAL_DISABLE_BUNDLE !== "1";
const serverBundlePath = `.local/test-server-${runId}.cjs`;
// e2e (alles außer Vitest) liefert einen echten Client aus. Beim Bundle-Boot
// bauen wir den Vite-Client pro Lauf in dieses Verzeichnis vor; beim tsx-Boot
// rendert weiterhin der Vite-Dev-Server (kein Vorab-Build nötig).
const needsClient = !isVitest;
const clientStaticDir = `.local/test-client-${runId}`;
const clientStaticDirAbs = resolvePath(clientStaticDir);
const buildClientBundle = useServerBundle && needsClient;

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

function cleanupBundle(): void {
  if (!useServerBundle) return;
  try {
    rmSync(serverBundlePath, { force: true });
  } catch {
    // ignore
  }
}

function cleanupClient(): void {
  if (!buildClientBundle) return;
  try {
    rmSync(clientStaticDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function teardown(): void {
  killServers();
  dropAllDbs();
  cleanupBundle();
  cleanupClient();
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

// Task #908: Baut den Vite-Client EINMAL pro Lauf in `clientStaticDirAbs` vor,
// damit der gebündelte e2e-Server ihn statisch ausliefern kann (statt eines
// teuren Vite-Dev-Servers pro Boot). Läuft als eigener Prozess → kann parallel
// zur DB-Provisionierung (drizzle-kit push + Seeds) laufen, sodass der reine
// Server-Boot danach schnell ist. `NODE_ENV=production` baut den Client wie im
// Prod-Pfad (ohne Dev-Plugins); der Server selbst läuft weiter mit `NODE_ENV=test`.
function buildClientAsync(): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    console.log(`[ephemeral-db] Baue Vite-Client (einmal pro Lauf) → ${clientStaticDirAbs} ...`);
    const child = spawn(
      "npx",
      ["vite", "build", "--outDir", clientStaticDirAbs, "--emptyOutDir"],
      { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`[ephemeral-db] Vite-Client fertig in ${Date.now() - t0}ms.`);
        resolve();
      } else {
        reject(new Error(`vite build fehlgeschlagen (exit ${code})`));
      }
    });
  });
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

// --- Task #907: Cache-Template-Helfer -------------------------------------
const cacheUrl = urlForDb(CACHE_DB_NAME);

function dbExists(name: string): boolean {
  const res = psql(adminUrl!, `SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  return res.ok && res.stdout.trim() === "1";
}

// Liest den in der Cache-DB als `COMMENT ON DATABASE` hinterlegten Template-Hash.
// null = DB fehlt oder kein Kommentar gesetzt.
function readCacheHash(): string | null {
  if (!dbExists(CACHE_DB_NAME)) return null;
  const res = psql(
    adminUrl!,
    `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${CACHE_DB_NAME}'`,
  );
  if (!res.ok) return null;
  const val = res.stdout.trim();
  return val.length > 0 ? val : null;
}

// Kappt alle Fremd-Verbindungen zu einer DB (Voraussetzung für `CREATE DATABASE
// ... TEMPLATE`, das eine verbindungsfreie Vorlage verlangt).
function terminateConnections(dbName: string): void {
  psql(
    adminUrl!,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
}

// Schema-Push + Seeds in die über `dbUrl` adressierte DB. Geteilt von Cache-Bau
// und Legacy-Direkt-Bau (Caching deaktiviert).
function seedTemplateInto(dbUrl: string): void {
  const env: NodeJS.ProcessEnv = { ...baseEnv, DATABASE_URL: dbUrl };
  console.log("[ephemeral-db] Pushe Drizzle-Schema (drizzle-kit push --force) ...");
  run("npx", ["drizzle-kit", "push", "--force"], env);
  console.log("[ephemeral-db] Seede Test-Superadmin ...");
  run("npx", ["tsx", "scripts/ci-seed-superadmin.ts"], env);
  // Basis-Stammdaten (Nicht-System-Leistungen hauswirtschaft/alltagsbegleitung
  // inkl. Budget-Töpfen) seeden — die Startup-Hooks legen nur System-Services +
  // Pflegekassen an, viele Tests setzen aber diese zwei Basis-Leistungen voraus.
  console.log("[ephemeral-db] Seede Basis-Referenzdaten (Leistungen) ...");
  run("npx", ["tsx", "scripts/seed-test-reference-data.ts"], env);
}

// Klont `target` aus der Vorlage `source`. Da zwei GLEICHZEITIGE Läufe (Auto-Run
// + Validation) zeitgleich aus derselben Cache-Vorlage klonen können, retryt der
// CREATE bei „source database ... is being accessed by other users".
function cloneDbFromTemplate(target: string, source: string): void {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = psql(adminUrl!, `CREATE DATABASE "${target}" TEMPLATE "${source}"`);
    if (res.ok) return;
    const busy = /being accessed by other users|source database .* is being accessed/i.test(
      res.stdout,
    );
    if (busy && attempt < maxAttempts) {
      const waitMs = 250 * attempt;
      console.log(
        `[ephemeral-db] Vorlage ${source} gerade in Benutzung — Retry ${attempt}/${maxAttempts} in ${waitMs}ms ...`,
      );
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        /* busy-wait (spawnSync ist synchron) */
      }
      continue;
    }
    throw new Error(`CREATE DATABASE ${target} TEMPLATE ${source} fehlgeschlagen: ${res.stdout}`);
  }
}

// Stellt sicher, dass die persistente Cache-Template-DB für `hash` frisch ist.
// Warm = vorhanden + hinterlegter Hash passt -> nichts zu tun. Sonst neu bauen
// (drop + create + push + seed + Hash-Kommentar).
function ensureCacheTemplate(hash: string): void {
  const stored = readCacheHash();
  if (isCacheFresh(stored, hash)) {
    console.log(
      `[ephemeral-db] Cache-Template ${CACHE_DB_NAME} ist frisch (Hash passt) — Push + Seeds übersprungen.`,
    );
    return;
  }
  console.log(
    `[ephemeral-db] Cache-Template ${CACHE_DB_NAME} ${stored == null ? "fehlt" : "veraltet"} — wird neu gebaut ...`,
  );
  // FORCE kappt evtl. verbliebene Verbindungen eines hart abgebrochenen Baus.
  const dropped = psql(adminUrl!, `DROP DATABASE IF EXISTS "${CACHE_DB_NAME}" WITH (FORCE)`);
  if (!dropped.ok) {
    console.warn(`[ephemeral-db] Konnte alten Cache nicht droppen: ${dropped.stdout}`);
  }
  const created = psql(adminUrl!, `CREATE DATABASE "${CACHE_DB_NAME}"`);
  if (!created.ok) fail(`CREATE DATABASE ${CACHE_DB_NAME} fehlgeschlagen: ${created.stdout}`);

  seedTemplateInto(cacheUrl);
  terminateConnections(CACHE_DB_NAME);

  const commented = psql(
    adminUrl!,
    `COMMENT ON DATABASE "${CACHE_DB_NAME}" IS '${hash}'`,
  );
  if (!commented.ok) {
    console.warn(`[ephemeral-db] Konnte Cache-Hash nicht setzen: ${commented.stdout}`);
  }
  console.log(`[ephemeral-db] Cache-Template ${CACHE_DB_NAME} neu gebaut (Hash hinterlegt).`);
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

  // Task #903/#908: Worker booten aus dem vorab gebauten esbuild-Bundle mit
  // plain `node` (schneller als `tsx`-Kaltstart). Das Bundle ist API-only
  // (ohne ./vite). Vitest braucht keinen Client → TEST_SKIP_CLIENT=1. e2e
  // braucht eine SPA → der pro Lauf vorgebaute Vite-Client wird statisch
  // ausgeliefert (TEST_SERVE_STATIC_CLIENT=1 + CLIENT_STATIC_DIR), `./vite`
  // wird nie geladen. Fallback (EPHEMERAL_DISABLE_BUNDLE=1): tsx-Boot, e2e
  // dann wieder via Vite-Dev-Server (kein TEST_SKIP_CLIENT für e2e).
  const [spawnCmd, spawnArgs, extraEnv]: [string, string[], NodeJS.ProcessEnv] =
    useServerBundle
      ? [
          "node",
          [serverBundlePath],
          needsClient
            ? { TEST_SERVE_STATIC_CLIENT: "1", CLIENT_STATIC_DIR: clientStaticDirAbs }
            : { TEST_SKIP_CLIENT: "1" },
        ]
      : ["npx", ["tsx", "server/index.ts"], needsClient ? {} : { TEST_SKIP_CLIENT: "1" }];

  console.log(
    `[ephemeral-db] Starte App-Server (${dbName}) auf Port ${port} via ${spawnCmd} ${spawnArgs.join(" ")} (Logs: ${logPath}) ...`,
  );
  const child = spawn(spawnCmd, spawnArgs, {
    env: { ...baseEnv, ...extraEnv, DATABASE_URL: dbUrl, PORT: String(port) },
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
  // Verwaiste Wegwerf-DBs früherer (hart abgebrochener) Läufe aufräumen, bevor
  // die neue Lauf-DB angelegt wird. Nur verbindungslose, ausreichend alte DBs.
  // Die langlebige Cache-Template-DB (Task #907) ist hier explizit geschützt.
  sweepOrphans(adminUrl!, {
    log: (m) => console.log(`[ephemeral-db] ${m}`),
    protectedDbs: new Set([CACHE_DB_NAME]),
  });
  // ... und die zurückgebliebenen per-Worker-Server-Logs (Task #904). Aktive
  // Schwester-Läufe schreiben fortlaufend (frische mtime) → geschützt; die N
  // jüngsten werden ohnehin behalten.
  sweepOrphanLogs({ log: (m) => console.log(`[ephemeral-db] ${m}`) });

  // Task #908: Den Vite-Client-Build (e2e) JETZT als eigenen Prozess starten,
  // damit er PARALLEL zur (synchron blockierenden) DB-Provisionierung + dem
  // Server-Bundling läuft. Awaited wird er erst direkt vor dem Worker-Start —
  // so kostet der Client-Build kaum zusätzliche Wall-Clock-Zeit.
  const clientBuildPromise = buildClientBundle ? buildClientAsync() : null;

  // 1) Per-Lauf-Template bereitstellen.
  if (cachingEnabled) {
    // Task #907: Geseedete Cache-Template-DB über Läufe hinweg wiederverwenden.
    // Stimmt der Schema-/Seed-Hash mit dem zuletzt gebauten Cache überein,
    // entfallen Push + Seeds komplett — die Per-Lauf-Template wird in EINEM
    // CREATE DATABASE ... TEMPLATE aus dem Cache geklont (Sekunden statt ~24s).
    const hash = computeTemplateHash();
    ensureCacheTemplate(hash);
    console.log(
      `[ephemeral-db] Klone Per-Lauf-Template ${templateDb} aus Cache ${CACHE_DB_NAME} ...`,
    );
    cloneDbFromTemplate(templateDb, CACHE_DB_NAME);
  } else {
    // Caching deaktiviert (EPHEMERAL_DB_CACHE=0): altes Verhalten — Push + Seeds
    // frisch direkt in die Per-Lauf-Template.
    console.log(`[ephemeral-db] Erstelle Template-DB ${templateDb} (ohne Cache) ...`);
    const created = psql(adminUrl!, `CREATE DATABASE "${templateDb}"`);
    if (!created.ok) fail(`CREATE DATABASE fehlgeschlagen: ${created.stdout}`);
    seedTemplateInto(templateUrl);
  }

  // Restverbindungen zur Template kappen, damit das Klonen nicht blockiert.
  terminateConnections(templateDb);

  // 1b) Server EINMAL pro Lauf bündeln (Task #903/#908, beide Pfade). Alle Worker
  // booten danach aus diesem Bundle mit plain `node` (~3s statt ~13s tsx-Boot).
  if (useServerBundle) {
    const t0 = Date.now();
    console.log("[ephemeral-db] Baue Test-Server-Bundle (esbuild, API-only) ...");
    await buildServerBundle({ outfile: serverBundlePath, excludeClientServer: true });
    console.log(`[ephemeral-db] Test-Server-Bundle fertig in ${Date.now() - t0}ms (${serverBundlePath}).`);
  }

  // 1c) Auf den (parallel gestarteten) Vite-Client-Build warten — der e2e-Server
  // braucht die statischen Assets, bevor er bootet.
  if (clientBuildPromise) {
    await clientBuildPromise;
  }

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
