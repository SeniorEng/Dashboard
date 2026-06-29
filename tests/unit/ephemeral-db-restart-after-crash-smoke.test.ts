/**
 * Task #1492 — Smoke-Test: „Ein abgestürzter Lauf blockiert den nächsten nicht."
 *
 * Task #1489/#1490 haben die EINZELNEN Schutzschichten (Prozess-/DB-/Log-/
 * Artefakt-Sweep, PID-Preflight) jeweils isoliert abgesichert — die reine
 * Auswahl-/Entscheidungslogik in `tests/unit/ephemeral-db-process-sweep.test.ts`
 * und der echte Prozess-Kill end-to-end in
 * `tests/unit/ephemeral-db-process-sweep-e2e.test.ts`.
 *
 * Was dort NICHT abgedeckt ist und dieser Test liefert, ist die GESAMT-Garantie:
 * ein KOMPLETTER Orchestrator-Lauf (`scripts/with-ephemeral-db.ts`), der NACH
 * einem simulierten Hart-Abbruch gestartet wird — also mit zurückgebliebenen,
 * marker-tragenden, auf init reparenteten Test-Prozessen UND einer verwaisten
 * `cc_test_`-Wegwerf-DB im Cluster — und der trotzdem grün durchläuft, weil der
 * Sweep + PID-Preflight beim Start greifen.
 *
 * Der Lauf ist bewusst KLEIN gehalten:
 *   - genau 1 Worker (`EPHEMERAL_DB_WORKERS=1`),
 *   - das Test-Kommando ist ein triviales `node -e "process.exit(0)"` (das
 *     Sentinel-Argument `…-vitest` wählt den leichten API-only-Boot-Pfad, sodass
 *     KEIN Vite-Client gebaut werden muss — derselbe Pfad, den die echten
 *     Vitest-Läufe nehmen).
 * Provisioniert wird trotzdem ECHT: Wegwerf-DB klonen, App-Server bündeln +
 * booten, Health abwarten, Kommando ausführen, teardownen.
 *
 * KOSTEN/HERMETIK: Der Test startet einen echten Orchestrator-Subprozess (DB +
 * App-Server) und wartet, bis der gepflanzte Waisen-Prozess die Altersgrenze des
 * Prozess-Sweeps (ORPHAN_PROC_MIN_AGE_MS = 30s) überschreitet. Er ist daher
 * deutlich schwerer als ein normaler Unit-Test und läuft NICHT im Standard-
 * Aggregat, sondern nur on-demand über `EPHEMERAL_RESTART_SMOKE=1`
 * (= `npm run test:restart-smoke`). Alle in diesem Test angelegten Ressourcen
 * (Prozesse, Dateien, die verwaiste DB) werden im `afterEach` wieder abgeräumt.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  DB_PREFIX,
  enumerateProcesses,
  type ProcInfo,
} from "../../scripts/lib/ephemeral-db-sweep.ts";

// Nur on-demand: dieser Lauf bootet einen echten App-Server + Wegwerf-DB und
// wartet > 30s, damit der gepflanzte Waisen-Prozess alt genug für den Sweep ist.
// Im Standard-`npm run test` würde das nur Zeit/Ressourcen fressen (und einen
// Orchestrator IM Orchestrator schachteln). Aktivierung via Env-Flag.
const ENABLED = process.env.EPHEMERAL_RESTART_SMOKE === "1";

const adminUrl = process.env.DATABASE_URL;

// In diesem Test gestartete PIDs + angelegte Dateien + angelegte DBs — für
// sicheres Aufräumen, auch wenn eine Assertion fehlschlägt.
const spawnedPids = new Set<number>();
const createdFiles = new Set<string>();
const createdDbs = new Set<string>();

function rand(): string {
  return randomBytes(4).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => weg; EPERM => existiert (uns nur nicht erlaubt) => lebt.
    return (e as { code?: string }).code === "EPERM";
  }
}

function findProc(pid: number): ProcInfo | undefined {
  return enumerateProcesses().find((p) => p.pid === pid);
}

function psql(sql: string): { ok: boolean; stdout: string } {
  const res = spawnSync("psql", [adminUrl!, "-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    encoding: "utf8",
  });
  if (res.status !== 0) return { ok: false, stdout: (res.stderr || "").trim() };
  return { ok: true, stdout: (res.stdout || "").trim() };
}

function dbExists(name: string): boolean {
  const res = psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  return res.ok && res.stdout.trim() === "1";
}

// Legt eine verbindungslose `cc_test_`-Wegwerf-DB an, deren im Namen kodierter
// base36-Zeitstempel BEWUSST 20 Minuten in der Vergangenheit liegt — damit sie
// die DB-Sweep-Altersgrenze (ORPHAN_MIN_AGE_MS = 15min) überschreitet und beim
// nächsten Orchestrator-Start als Waise gedroppt wird (kein Warten nötig).
function createStaleOrphanDb(): string {
  const oldTs = (Date.now() - 20 * 60 * 1000).toString(36);
  const name = `${DB_PREFIX}${oldTs}_smoke_${rand()}`;
  const res = psql(`CREATE DATABASE "${name}"`);
  if (!res.ok) throw new Error(`Konnte verwaiste Test-DB nicht anlegen: ${res.stdout}`);
  createdDbs.add(name);
  return name;
}

// Minimales Keepalive-Skript (läuft, bis es gekillt wird).
function writeKeepaliveScript(path: string): void {
  mkdirSync(".local", { recursive: true });
  writeFileSync(path, "setInterval(() => {}, 1 << 30);\n");
  createdFiles.add(path);
}

// Startet einen Prozess via Double-Fork, sodass der Enkel nach dem sofortigen
// Beenden des Zwischen-Eltern auf init (PPID 1) reparentet wird — exakt der
// Zustand nach einem Hard-Kill des Orchestrators. Liefert die Enkel-PID.
function spawnReparentedOrphan(scriptPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const spawnerCode = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, [${JSON.stringify(scriptPath)}], {
        detached: true,
        stdio: 'ignore',
      });
      gc.unref();
      process.stdout.write(String(gc.pid));
      process.exit(0);
    `;
    const spawner = spawn(process.execPath, ["-e", spawnerCode], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    spawner.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    spawner.once("error", reject);
    spawner.once("exit", () => {
      const pid = Number(out.trim());
      if (Number.isFinite(pid) && pid > 0) {
        spawnedPids.add(pid);
        resolve(pid);
      } else {
        reject(new Error(`Konnte Orphan-PID nicht lesen (out=${JSON.stringify(out)})`));
      }
    });
  });
}

async function waitForReparent(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = findProc(pid);
    if (p && p.ppid === 1) return;
    await sleep(50);
  }
  throw new Error(`Prozess ${pid} wurde nicht auf init (PPID 1) reparentet`);
}

// Wartet, bis `ps etimes` für den Prozess mindestens `minSec` Sekunden meldet —
// damit der Prozess-Sweep des Orchestrators (Altersgrenze 30s) ihn als Waise
// anerkennt und nicht wegen der Reparent-Race-Schutzgrenze überspringt.
async function waitForAge(pid: number, minSec: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = findProc(pid);
    if (p && p.etimeSec >= minSec) return;
    if (!isAlive(pid)) throw new Error(`Prozess ${pid} starb vor Erreichen des Mindestalters`);
    await sleep(500);
  }
  throw new Error(`Prozess ${pid} erreichte das Mindestalter ${minSec}s nicht`);
}

afterEach(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // keine Prozessgruppe / schon weg
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // schon weg
    }
  }
  spawnedPids.clear();
  for (const f of createdFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
  createdFiles.clear();
  for (const name of createdDbs) {
    if (adminUrl) psql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  createdDbs.clear();
});

describe.skipIf(!ENABLED)("Orchestrator-Neustart nach Hart-Abbruch (Smoke, Task #1492)", () => {
  it(
    "räumt verwaiste Prozesse + DB ab und führt einen vollständigen Lauf grün zu Ende",
    async () => {
      expect(adminUrl, "DATABASE_URL muss gesetzt sein").toBeTruthy();

      const tag = rand();

      // --- 1) Den Zustand NACH einem Hart-Abbruch simulieren --------------
      // a) Verwaister, marker-tragender Test-App-Server: der Server-Marker steckt
      //    im Pfad selbst (.local/test-server-<id>.cjs), Reparenting auf init via
      //    Double-Fork (= genau das, was ein SIGKILL des Orchestrators hinterlässt).
      const serverScript = `.local/test-server-smoke-${tag}.cjs`;
      writeKeepaliveScript(serverScript);
      const serverOrphan = await spawnReparentedOrphan(serverScript);
      await waitForReparent(serverOrphan);

      // b) Verwaiste `cc_test_`-Wegwerf-DB aus einem abgestürzten Lauf (alt genug
      //    für den DB-Sweep).
      const staleDb = createStaleOrphanDb();
      expect(dbExists(staleDb), "Vorbereitung: verwaiste DB sollte existieren").toBe(true);

      // c) Den Waisen-Prozess über die Sweep-Altersgrenze (30s) altern lassen,
      //    damit der nächste Lauf ihn als echte Waise (nicht als Reparent-Race)
      //    erkennt und killt.
      await waitForAge(serverOrphan, 31);

      // --- 2) Echten, kleinen Orchestrator-Lauf starten -------------------
      // 1 Worker, triviales Kommando. Das Sentinel `…-vitest` wählt den leichten
      // API-only-Pfad (kein Vite-Client-Build). Provisionierung + Server-Boot
      // laufen trotzdem real.
      const res = spawnSync(
        "npx",
        [
          "tsx",
          "scripts/with-ephemeral-db.ts",
          "5099",
          "node",
          "-e",
          "process.exit(0)",
          "ephemeral-restart-smoke-vitest",
        ],
        {
          encoding: "utf8",
          timeout: 240_000,
          env: { ...process.env, EPHEMERAL_DB_WORKERS: "1" },
        },
      );
      const out = `${res.stdout || ""}\n${res.stderr || ""}`;

      // --- 3) Beweise -----------------------------------------------------
      // Der Lauf endete grün (nicht an einem verwaisten Zustand gescheitert).
      expect(res.status, `Orchestrator-Lauf nicht grün.\n${out}`).toBe(0);
      // ... und insbesondere NICHT an erschöpftem PID-Limit.
      expect(out, "Lauf scheiterte an spawn EAGAIN").not.toMatch(/EAGAIN/);

      // PID-Preflight hat beim Start gegriffen (Diagnose-Zeile vorhanden).
      expect(out, "PID-Preflight-Zeile fehlt").toMatch(/PID-Auslastung:/);

      // Prozess-Sweep hat gegriffen: der verwaiste Server-Prozess ist real tot.
      expect(isAlive(serverOrphan), "verwaister Server-Prozess lebt noch").toBe(false);

      // DB-Sweep hat gegriffen: die verwaiste `cc_test_`-DB wurde gedroppt.
      expect(dbExists(staleDb), "verwaiste Test-DB wurde nicht gedroppt").toBe(false);
    },
    300_000,
  );
});
