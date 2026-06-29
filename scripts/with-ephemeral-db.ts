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
import {
  DB_PREFIX,
  evaluatePidPreflight,
  readPidStats,
  sweepOrphanArtifacts,
  sweepOrphanLogs,
  sweepOrphanProcesses,
  sweepOrphans,
} from "./lib/ephemeral-db-sweep.ts";
import {
  CACHE_BUILD_LOCK_KEY,
  CACHE_DB_NAME,
  DEFAULT_GLOBAL_WORKER_BUDGET,
  WORKER_SLOT_LOCK_BASE,
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

// Task #910: Verify-/Diagnose-Modus. Stellt NUR die (ggf. gecachte) Per-Lauf-
// Template-DB bereit und bricht dann VOR dem Server-Bundle/-Boot + Testlauf ab.
// Genau das, was der Cache-Verify-Pfad (scripts/verify-template-cache.ts) zum
// Messen des Warm-/Kalt-Ausgangs braucht — ohne den App-Server-Boot, der im CI
// hinter dem fix verdrahteten Neon-Proxy ohnehin nicht pro DB routen würde.
const provisionOnly = process.env.EPHEMERAL_PROVISION_ONLY === "1";

const runId = `${Date.now().toString(36)}_${process.pid}_${randomBytes(4).toString("hex")}`;
const templateDb = `${DB_PREFIX}${runId}_tmpl`;
// Task #1489: Die effektive Worker-Anzahl kann durch das clusterweite Worker-Slot-
// Gate (acquireWorkerSlots) nach unten gedeckelt werden, wenn parallel weitere
// Orchestrator-Läufe (Auto-Run + Validation) aktiv sind. Deshalb erst in main()
// final befüllt, nachdem die Slots reserviert sind. dropAllDbs() liest die Liste
// zur Aufrufzeit (DROP ... IF EXISTS ist für nie angelegte Namen ein No-op).
let workerDbs: string[] = [];

// Task #1489: Freigabe-Handle für die clusterweit reservierten Worker-Slots
// (acquireWorkerSlots). Wird im teardown() aufgerufen, damit Schwester-Läufe die
// Slots zurückbekommen — auch bei Signal/Abbruch.
let releaseWorkerSlots: () => void = () => {};

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

// Task #1489: Worker-App-Server werden in einer EIGENEN Prozessgruppe gestartet
// (spawn detached:true → pgid === pid). Deshalb killen wir hier den GANZEN Baum
// über die negative PID (`kill(-pid)`), damit die vom Server für die PDF-
// Generierung gestarteten Chromium-ENKEL mitsterben — ein reines `child.kill()`
// am Node-Server würde sie sonst auf init umhängen und als Waisen zurücklassen
// (genau die PID-Fresser, die dieser Task beseitigt). Der Einzel-Kill folgt als
// Fallback, falls keine Gruppe existiert (alter tsx-Boot / schon beendet).
function killServers(): void {
  for (const child of serverChildren) {
    if (!child || child.killed || child.pid == null) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // keine Prozessgruppe / schon weg → Einzel-Kill versuchen.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
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
  // Task #1489: Clusterweite Worker-Slots zurückgeben (No-op, wenn nie reserviert).
  try {
    releaseWorkerSlots();
  } catch {
    // Freigabe darf den Teardown nie scheitern lassen.
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    teardown();
    process.exit(1);
  });
}

// Task #1489: Letzter Best-Effort-Reaper. Auch wenn der Lauf über einen anderen
// Pfad endet (unerwarteter Throw, manueller process.exit irgendwo), schießen wir
// im `exit`-Handler die Server-Prozessgruppen noch synchron ab, damit keine
// Chromium-Enkel zurückbleiben. Hier ist nur SYNCHRONE Arbeit erlaubt — killServers()
// ist rein synchron (process.kill), DB-/Datei-Cleanup übernimmt der reguläre
// teardown() im .then/.catch von main(). Idempotent (child.killed-Guard).
process.on("exit", () => {
  try {
    killServers();
  } catch {
    // exit-Handler darf niemals selbst werfen.
  }
});

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  // Task #1051: Lauf-eindeutige Run-ID. Der Object-Storage-Bucket ist (anders als
  // die Ephemeral-DBs) NICHT pro Lauf isoliert; PDF-Objektschlüssel würden sonst
  // zwischen parallelen Läufen (gleiche Rechnungsnummern aus frischen DBs)
  // kollidieren. Wird sowohl von den Worker-App-Servern (siehe startWorker) als
  // auch vom Vitest-Prozess (testEnv = { ...baseEnv, ... }) geerbt, sodass beide
  // Seiten denselben pro-Lauf-gescopten Prefix `_nonprod/<env>/run-<id>` bilden
  // (server/lib/object-storage-helpers.ts → getInvoicePdfKeyPrefix).
  EPHEMERAL_RUN_ID: runId,
  TEST_USER_PASSWORD:
    process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL,
  // Chromium-Drosselung: Jeder Worker-App-Server rendert PDFs nur 1× gleichzeitig.
  // Bei mehreren Workern (eigener Server je Worker) parallel zu den e2e-Browsern
  // sprengen sonst die addierten Chromium-Threads das cgroup-pids-Limit (~1024)
  // -> `spawn EAGAIN`. Overridebar, falls bewusst höher gefahren werden soll.
  PDF_RENDER_CONCURRENCY: process.env.PDF_RENDER_CONCURRENCY || "1",
};

// Dev-only Feature-Flags dürfen NICHT in den Test-Server (oder den Vitest-Prozess)
// lecken. `BUDGET_HARD_HOLDS=1` ist in `.replit` unter `[userenv.development]`
// UND `[userenv.production]` gesetzt (Task #953: Hard-Block scharf in Prod), damit
// die laufende Dev-App und das Deployment den gegateten Hard-Hold-Pfad ausüben — der
// Workflow-Prozess (und damit dieser Orchestrator) erbt den Dev-Wert. In CI ist das
// Flag NIE gesetzt; die Test-Suite (insb. `tests/budget/hard-holds-engine.test.ts`) treibt
// die Hard-Hold-Engine bewusst DIREKT und setzt einen Server OHNE das Flag voraus.
// Geerbt würde es die gegateten Route-Hooks (planHold bei Terminanlage, captureHolds
// beim Abschluss) feuern lassen und diese Tests environment-abhängig rotbrechen.
// → Hier hart entfernen, damit lokale Läufe deterministisch CI spiegeln.
delete baseEnv.BUDGET_HARD_HOLDS;

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

// Task #913: Serialisiert KONKURRIERENDE kalte Cache-Aufbauten über einen
// Cluster-weiten Postgres-Advisory-Lock. Zwei gleichzeitig gestartete Läufe
// (Auto-Run + Validation: `test` und `e2e-smoke` parallel) würden bei FEHLENDEM
// Cache sonst beide dieselbe Cache-DB droppen/erzeugen und gleichzeitig
// `drizzle-kit push --force` dagegen feuern → einer scheitert mit exit 1.
//
// Der Lock wird über eine PERSISTENTE psql-Session gehalten: `pg_advisory_lock`
// gilt für die Dauer der Session, daher genügt EIN spawnSync-Aufruf NICHT (er
// würde den Lock beim Prozess-Ende sofort wieder freigeben). Wir starten daher
// einen langlebigen psql-Prozess, der den Lock greift und dann auf weiteren
// stdin wartet — der Lock bleibt gehalten, bis wir stdin schließen/den Prozess
// killen. Bricht der Lock-Halter (oder der ganze Lauf) hart ab, gibt Postgres
// den Lock automatisch beim Verbindungsabbruch frei (kein verwaister Lock-File).
//
// Gibt eine `release`-Funktion zurück; bei Timeout/Fehler wird hart abgebrochen.
function acquireCacheBuildLock(timeoutMs = 180_000): Promise<() => void> {
  return new Promise((resolve, reject) => {
    // Eigene psql-Session (-X = keine ~/.psqlrc); SQL kommt über stdin, das wir
    // bewusst offen halten, damit die Session — und damit der Lock — bestehen
    // bleibt. Der Lock-Schlüssel ist Cluster-weit, also datenbankübergreifend.
    const child = spawn("psql", [adminUrl!, "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let acquired = false;
    let settled = false;
    let out = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`Cache-Build-Lock nicht innerhalb von ${timeoutMs}ms erlangt`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString();
      if (!acquired && out.includes("LOCK_ACQUIRED")) {
        acquired = true;
        settled = true;
        clearTimeout(timer);
        resolve(() => {
          try {
            child.stdin.end();
          } catch {
            // ignore
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        });
      }
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (acquired || settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Lock-psql endete (code ${code}) bevor der Lock erlangt wurde. ${stderr.trim()}`,
        ),
      );
    });

    // SELECT blockiert, bis der Lock erlangt ist; `\echo` signalisiert das dann.
    child.stdin.write(
      `SELECT pg_advisory_lock(${CACHE_BUILD_LOCK_KEY});\n\\echo LOCK_ACQUIRED\n`,
    );
  });
}

// Stellt sicher, dass die persistente Cache-Template-DB für `hash` frisch ist.
// Warm = vorhanden + hinterlegter Hash passt -> nichts zu tun. Sonst neu bauen
// (drop + create + push + seed + Hash-Kommentar). Gibt zurück, ob der Cache
// wiederverwendet (`"warm"`) oder neu gebaut (`"cold"`) wurde — so kann der
// Verify-Pfad (Task #910) den Warm-/Kalt-Ausgang deterministisch prüfen.
function ensureCacheTemplate(hash: string): "warm" | "cold" {
  const stored = readCacheHash();
  if (isCacheFresh(stored, hash)) {
    console.log(
      `[ephemeral-db] Cache-Template ${CACHE_DB_NAME} ist frisch (Hash passt) — Push + Seeds übersprungen.`,
    );
    return "warm";
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
  return "cold";
}

// Task #1489: Reserviert clusterweit bis zu `desired` Worker-Slots aus einem
// GEMEINSAMEN Budget per Postgres-Advisory-Locks (siehe WORKER_SLOT_LOCK_BASE in
// template-cache.ts). Mehrere gleichzeitige Orchestrator-Läufe (Auto-Run +
// Validation) teilen sich so das Budget und sprengen das cgroup-pids-Limit nicht.
//
// Die Locks werden — wie acquireCacheBuildLock — über eine PERSISTENTE psql-
// Session gehalten (Advisory-Locks gelten für die Session-Dauer); die zurück-
// gegebene `release`-Funktion beendet die Session (auch ein harter Abbruch gibt
// die Locks via Verbindungsabbruch frei). FAIL-SAFE: bei jedem Fehler/Timeout
// läuft der Lauf mit der vollen `desired`-Zahl weiter (Tests nie blockieren).
function acquireWorkerSlots(
  desired: number,
  budget: number,
  timeoutMs = 30_000,
): Promise<{ granted: number; release: () => void }> {
  return new Promise((resolve) => {
    const noop = () => {};
    const fallbackFull = () => resolve({ granted: desired, release: noop });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("psql", [adminUrl!, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      fallbackFull();
      return;
    }

    let out = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      fallbackFull();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (buf: Buffer) => {
      out += buf.toString();
      if (settled || !out.includes("SLOTS_DONE")) return;
      settled = true;
      clearTimeout(timer);

      // psql -tA liefert je Zeile `i|t` bzw. `i|f`.
      const acquired: number[] = [];
      for (const line of out.split("\n")) {
        const m = line.match(/^(\d+)\|(t|f)$/);
        if (m && m[2] === "t") acquired.push(Number(m[1]));
      }
      const target = Math.min(desired, acquired.length);
      const surplus = acquired.slice(target);
      // Überschüssig belegte Slots sofort wieder freigeben, damit Schwester-Läufe
      // sie bekommen (wir wollten nur `desired`).
      if (surplus.length > 0 && child.stdin) {
        child.stdin.write(
          surplus.map((i) => `SELECT pg_advisory_unlock(${WORKER_SLOT_LOCK_BASE} + ${i});`).join("\n") +
            "\n",
        );
      }
      // Mind. 1 Worker, auch wenn alle Slots vergeben waren (Tests nie blocken).
      const granted = target > 0 ? target : 1;
      resolve({
        granted,
        release: () => {
          try {
            child.stdin?.end();
          } catch {
            // ignore
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        },
      });
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fallbackFull();
    });
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fallbackFull();
    });

    child.stdin?.write(
      `SELECT i, pg_try_advisory_lock(${WORKER_SLOT_LOCK_BASE} + i) FROM generate_series(0, ${budget - 1}) AS i;\n\\echo SLOTS_DONE\n`,
    );
  });
}

interface WorkerHandle {
  dbName: string;
  dbUrl: string;
  port: number;
  baseUrl: string;
}

async function startWorker(dbName: string, workerIndex: number): Promise<WorkerHandle> {
  const dbUrl = urlForDb(dbName);

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
    // Task #1263: EPHEMERAL_WORKER_ID isoliert den PDF-Objektschlüssel-Raum pro
    // Worker (zusätzlich zu EPHEMERAL_RUN_ID). Der gepaarte Vitest-Fork setzt in
    // tests/setup.ts denselben Wert (über die VITEST_POOL_ID → Index-Zuordnung),
    // sodass App-Server und Direkt-DB-/In-Process-Renders denselben
    // `_nonprod/<env>/run-<id>/w-<index>`-Prefix bilden.
    env: {
      ...baseEnv,
      ...extraEnv,
      DATABASE_URL: dbUrl,
      PORT: String(port),
      EPHEMERAL_WORKER_ID: String(workerIndex),
    },
    stdio: ["ignore", logFd, logFd],
    // Task #1489: Eigene Prozessgruppe (pgid === pid), damit killServers() per
    // `kill(-pid)` den GANZEN Baum inkl. der Chromium-Enkel (PDF-Rendering) als
    // Gruppe beendet — sonst verwaisen die Enkel auf init und fressen PIDs.
    detached: true,
  });
  // Wir warten/teardownen den Prozess selbst; nicht am Eltern-Event-Loop hängen
  // lassen (detached). Referenz bleibt über serverChildren erhalten.
  child.unref();
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

  // Task #1489: ... und die zurückgebliebenen VERWAISTEN PROZESSE (Test-App-
  // Server + deren Chromium-Enkel) aus hart abgebrochenen Läufen — die eigentlichen
  // PID-Fresser. Nur an init reparentete, marker-eindeutige Test-Prozesse werden
  // angefasst; ein parallel laufender Schwester-Lauf (PPID ≠ 1) bleibt verschont.
  // Fail-safe: blockiert den Lauf nie.
  const procSweep = sweepOrphanProcesses({ log: (m) => console.log(`[ephemeral-db] ${m}`) });
  if (procSweep.killed.length > 0) {
    console.log(
      `[ephemeral-db] Prozess-Sweep: ${procSweep.killed.length} verwaiste Test-Prozess(e) beendet.`,
    );
  }

  // Task #1492: ... und ZULETZT die zurückgebliebenen per-Run-BUILD-ARTEFAKTE
  // (gebündelte Server `.local/test-server-<runId>.cjs` + statische Client-Builds
  // `.local/test-client-<runId>/`) aus hart abgebrochenen Läufen — der größte
  // Workspace-Platzfresser. Bewusst NACH dem Prozess-Sweep: ein gerade beendeter
  // verwaister Server gibt seine runId frei, sodass dessen Artefakte im selben
  // Durchlauf mit abgeräumt werden (frische Prozessliste). Ein laufender
  // Schwester-Lauf (Server-Prozess hält die runId in der Kommandozeile) bleibt
  // verschont. Fail-safe: blockiert nie.
  const artifactSweep = sweepOrphanArtifacts({
    log: (m) => console.log(`[ephemeral-db] ${m}`),
  });
  if (artifactSweep.dropped.length > 0) {
    console.log(
      `[ephemeral-db] Artefakt-Sweep: ${artifactSweep.dropped.length} verwaiste Build-Artefakt(e) entfernt.`,
    );
  }

  // Task #1489: PID-Preflight. NACH dem Sweep (der erst PIDs freigibt) prüfen, ob
  // das cgroup-pids-Limit immer noch (fast) ausgeschöpft ist. Wenn ja, sofort mit
  // klarer Anleitung abbrechen, statt später mitten im Lauf an `spawn EAGAIN` zu
  // zerschellen. Abschaltbar via EPHEMERAL_PID_PREFLIGHT=0; Schwelle via
  // EPHEMERAL_PID_PREFLIGHT_RATIO (Default 0.8). Im Provision-Only-Modus (CI-
  // Verify) übersprungen — dort wird kein Server-/Chromium-Baum gestartet.
  if (!provisionOnly && process.env.EPHEMERAL_PID_PREFLIGHT !== "0") {
    const ratio = Number(process.env.EPHEMERAL_PID_PREFLIGHT_RATIO || "0.8") || 0.8;
    const pre = evaluatePidPreflight(readPidStats(), ratio);
    if (pre.max != null) {
      console.log(
        `[ephemeral-db] PID-Auslastung: ${pre.current}/${pre.max} (${((pre.ratio ?? 0) * 100).toFixed(0)}%, Schwelle ${(ratio * 100).toFixed(0)}%).`,
      );
    }
    if (!pre.ok) {
      fail(
        `Abbruch: Die Prozess-/PID-Auslastung des Workspaces ist zu hoch ` +
          `(${pre.current}/${pre.max}, über ${(ratio * 100).toFixed(0)}%). Ein Start würde ` +
          `mitten im Lauf an „spawn EAGAIN“ scheitern. Bitte zuerst aufräumen:\n` +
          `    npm run test:unblock\n` +
          `Das beendet verwaiste Test-Prozesse/-DBs/-Logs. Danach den Lauf erneut starten.`,
      );
    }
  }

  // Task #908: Den Vite-Client-Build (e2e) JETZT als eigenen Prozess starten,
  // damit er PARALLEL zur (synchron blockierenden) DB-Provisionierung + dem
  // Server-Bundling läuft. Awaited wird er erst direkt vor dem Worker-Start —
  // so kostet der Client-Build kaum zusätzliche Wall-Clock-Zeit.
  const clientBuildPromise = buildClientBundle && !provisionOnly ? buildClientAsync() : null;

  // 1) Per-Lauf-Template bereitstellen.
  if (cachingEnabled) {
    // Task #907: Geseedete Cache-Template-DB über Läufe hinweg wiederverwenden.
    // Stimmt der Schema-/Seed-Hash mit dem zuletzt gebauten Cache überein,
    // entfallen Push + Seeds komplett — die Per-Lauf-Template wird in EINEM
    // CREATE DATABASE ... TEMPLATE aus dem Cache geklont (Sekunden statt ~24s).
    const hash = computeTemplateHash();
    // Warm-Pfad bleibt lock-frei (kein Overhead, wenn der Cache schon frisch
    // ist): Wir prüfen die Frische zuerst OHNE Lock und holen den serialisierenden
    // Build-Lock NUR, wenn neu gebaut werden muss (Task #913).
    let cacheResult: "warm" | "cold";
    if (isCacheFresh(readCacheHash(), hash)) {
      cacheResult = ensureCacheTemplate(hash); // schneller Warm-Pfad, kein Lock
    } else {
      console.log(
        `[ephemeral-db] Cache nicht frisch — hole Build-Lock (serialisiert konkurrierende Aufbauten) ...`,
      );
      const release = await acquireCacheBuildLock();
      try {
        // Double-Checked: Ein parallel gestarteter Lauf könnte den Cache gebaut
        // haben, während wir auf den Lock warteten — ensureCacheTemplate prüft
        // die Frische erneut und liefert dann "warm" zurück (kein Re-Build).
        cacheResult = ensureCacheTemplate(hash);
      } finally {
        release();
      }
    }
    // Task #910: Maschinen-lesbarer Marker, damit der Verify-Pfad den Warm-/
    // Kalt-Ausgang ohne Log-Heuristik prüfen kann.
    console.log(`[ephemeral-db] CACHE_RESULT=${cacheResult}`);
    console.log(
      `[ephemeral-db] Klone Per-Lauf-Template ${templateDb} aus Cache ${CACHE_DB_NAME} ...`,
    );
    cloneDbFromTemplate(templateDb, CACHE_DB_NAME);
  } else {
    // Caching deaktiviert (EPHEMERAL_DB_CACHE=0): altes Verhalten — Push + Seeds
    // frisch direkt in die Per-Lauf-Template.
    console.log(`[ephemeral-db] CACHE_RESULT=disabled`);
    console.log(`[ephemeral-db] Erstelle Template-DB ${templateDb} (ohne Cache) ...`);
    const created = psql(adminUrl!, `CREATE DATABASE "${templateDb}"`);
    if (!created.ok) fail(`CREATE DATABASE fehlgeschlagen: ${created.stdout}`);
    seedTemplateInto(templateUrl);
  }

  // Restverbindungen zur Template kappen, damit das Klonen nicht blockiert.
  terminateConnections(templateDb);

  // Task #910: Im Verify-/Diagnose-Modus ist die Template jetzt bereitgestellt —
  // wir brechen VOR Server-Bundle/-Boot + Testlauf sauber ab. Der nachfolgende
  // teardown() (im .then-Handler) droppt die Per-Lauf-DBs wieder; die langlebige
  // Cache-DB bleibt erhalten.
  if (provisionOnly) {
    console.log(
      `[ephemeral-db] EPHEMERAL_PROVISION_ONLY=1 — Template bereit, beende vor Server-Boot/Testlauf.`,
    );
    return 0;
  }

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

  // 2) Worker-DBs aus der Template klonen + je einen App-Server starten.
  //
  // Task #1263: Das Klonen läuft SERIELL, das Server-Booten danach parallel.
  // `CREATE DATABASE ... TEMPLATE <src>` verlangt, dass NIEMAND sonst auf die
  // Quelle zugreift — und ein laufendes Klonen zählt selbst als Zugriff. Zwei
  // GLEICHZEITIGE Klone aus DERSELBEN Per-Lauf-Template (so wie es das frühere
  // `Promise.all(map(startWorker))` tat) scheiterten daher sporadisch mit
  // „source database ... is being accessed by other users". Serielles Klonen
  // (über `cloneDbFromTemplate` mit Retry als zusätzliche Absicherung) entfernt
  // die Race; das anschließende parallele Booten kostet keine zusätzliche
  // Wall-Clock-Zeit, da es nicht mehr gegen die Quelle konkurriert.
  // Task #1489: Clusterweites Worker-Slot-Gate. Laufen parallel weitere
  // Orchestrator-Läufe (Auto-Run + Validation), teilen sich alle EIN gemeinsames
  // Worker-Budget; dieser Lauf bekommt dann ggf. weniger Worker und überschreitet
  // das cgroup-pids-Limit nicht. Budget via EPHEMERAL_GLOBAL_WORKER_BUDGET
  // (Default DEFAULT_GLOBAL_WORKER_BUDGET); `0` deaktiviert das Gate. Fail-safe:
  // bei Fehler/Timeout volle workerCount.
  const globalWorkerBudget = Number(
    process.env.EPHEMERAL_GLOBAL_WORKER_BUDGET ?? String(DEFAULT_GLOBAL_WORKER_BUDGET),
  );
  let effectiveWorkerCount = workerCount;
  if (Number.isFinite(globalWorkerBudget) && globalWorkerBudget > 0) {
    const slots = await acquireWorkerSlots(workerCount, globalWorkerBudget);
    releaseWorkerSlots = slots.release;
    effectiveWorkerCount = Math.max(1, Math.min(workerCount, slots.granted));
    if (effectiveWorkerCount < workerCount) {
      console.log(
        `[ephemeral-db] Worker-Slot-Gate: ${effectiveWorkerCount}/${workerCount} Worker ` +
          `(gemeinsames Budget ${globalWorkerBudget}, parallele Läufe aktiv).`,
      );
    }
  }

  // Worker-DB-Namen erst JETZT festlegen — nach dem Slot-Gate, das die effektive
  // Worker-Zahl deckelt. dropAllDbs() liest workerDbs zur Aufrufzeit.
  workerDbs = Array.from(
    { length: effectiveWorkerCount },
    (_, i) => `${DB_PREFIX}${runId}_w${i}`,
  );

  console.log(`[ephemeral-db] Provisioniere ${effectiveWorkerCount} Worker (DB + Server) ...`);
  for (const db of workerDbs) {
    cloneDbFromTemplate(db, templateDb);
  }
  const handles = await Promise.all(
    workerDbs.map((db, i) => startWorker(db, i)),
  );
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
    EPHEMERAL_DB_WORKERS: String(effectiveWorkerCount),
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
