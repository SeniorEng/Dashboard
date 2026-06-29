/**
 * Task #1490 — Integrations-/End-to-End-Test für den Prozess-Orphan-Sweep.
 *
 * Die REINE Erkennungs-/Auswahllogik ist bereits in
 * `tests/unit/ephemeral-db-process-sweep.test.ts` mit injizierten Prozesslisten
 * abgesichert. Dieser Test deckt den eigentlichen geschäftskritischen Pfad ab,
 * der dort NICHT abgedeckt ist: ein HART abgebrochener Lauf hinterlässt einen
 * echten, an init reparenteten (PPID 1), marker-tragenden Prozess — und der
 * nächste Lauf räumt ihn AUTOMATISCH wieder ab, fasst dabei aber weder einen
 * fremden Prozess noch einen marker-tragenden Prozess mit lebendem Eltern an.
 *
 * Anders als der Unit-Test laufen hier ECHTE Prozesse:
 *   - echtes Reparenting auf init via Double-Fork (Zwischen-Eltern beendet sich,
 *     der Enkel hängt danach an PID 1 — genau wie nach einem Hard-Kill des
 *     Orchestrators/Servers),
 *   - die ECHTE `enumerateProcesses()` (spawnt `ps`, parst dessen Ausgabe),
 *   - der ECHTE `process.kill` (kein injizierter Fake).
 *
 * SICHERHEIT/HERMETIK: Damit der Test bei paralleler Ausführung NIE fremde
 * (auch echte verwaiste) Prozesse killt, wird die reale Prozessliste vor dem
 * Sweep auf die in DIESEM Test selbst gestarteten PIDs eingegrenzt. Real bleiben
 * dabei das `ps`-Enumerieren/-Parsen, die Klassifikation, der PPID-Check und der
 * Kill — nur der Kandidatenkreis ist auf eigene Prozesse beschränkt.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  enumerateProcesses,
  sweepOrphanProcesses,
  TEST_CHROMIUM_PROC_MARKER,
  type ProcInfo,
} from "../../scripts/lib/ephemeral-db-sweep.ts";

// Alle in diesem Test gestarteten PIDs + angelegten Dateien — für sicheres
// Aufräumen, auch wenn eine Assertion fehlschlägt.
const spawnedPids = new Set<number>();
const createdFiles = new Set<string>();

function rand(): string {
  return randomBytes(4).toString("hex");
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

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Schreibt ein minimales Keepalive-Skript (läuft, bis es gekillt wird).
function writeKeepaliveScript(path: string): void {
  mkdirSync(".local", { recursive: true });
  // 1<<30 ms ~ 12 Tage; der Prozess wartet damit praktisch unbegrenzt.
  writeFileSync(path, "setInterval(() => {}, 1 << 30);\n");
  createdFiles.add(path);
}

// Startet einen Prozess via Double-Fork, sodass der Enkel nach dem sofortigen
// Beenden des Zwischen-Eltern auf init (PPID 1) reparentet wird — exakt der
// Zustand nach einem Hard-Kill des Orchestrators. Liefert die Enkel-PID.
function spawnReparentedOrphan(scriptPath: string, extraArgs: string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const spawnerCode = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, [${JSON.stringify(scriptPath)}, ...${JSON.stringify(extraArgs)}], {
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

// Wartet, bis der Prozess wirklich auf init (PPID 1) reparentet ist.
async function waitForReparent(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = findProc(pid);
    if (p && p.ppid === 1) return;
    await sleep(50);
  }
  throw new Error(`Prozess ${pid} wurde nicht auf init (PPID 1) reparentet`);
}

// Wartet, bis ein Prozess nicht mehr existiert.
async function waitForDeath(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
  throw new Error(`Prozess ${pid} lebt nach dem Sweep noch`);
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
});

describe("sweepOrphanProcesses (End-to-End mit echten Prozessen)", () => {
  it(
    "killt verwaiste, marker-tragende Test-Prozesse und verschont Fremd-/Live-Eltern-Prozesse",
    async () => {
      const tag = rand();
      // Der Server-Marker steckt im Pfad selbst (.local/test-server-<id>.cjs).
      const serverScript = `.local/test-server-itest-${tag}.cjs`;
      // Generisches Keepalive für Chromium-/Fremd-Orphan (Marker via Argument
      // bzw. gar nicht).
      const genericScript = `.local/sweep-itest-${tag}.cjs`;
      writeKeepaliveScript(serverScript);
      writeKeepaliveScript(genericScript);

      // 1) Verwaister Test-Server (PPID 1, Server-Marker im Pfad) → muss sterben.
      const serverOrphan = await spawnReparentedOrphan(serverScript);
      // 2) Verwaistes test-Chromium (PPID 1, Chromium-Marker im Argument) → muss sterben.
      const chromiumOrphan = await spawnReparentedOrphan(genericScript, [
        `--user-data-dir=/tmp/${TEST_CHROMIUM_PROC_MARKER}${tag}`,
      ]);
      // 3) Verwaister FREMDprozess (PPID 1, KEIN Marker) → darf NIE angefasst werden.
      const foreignOrphan = await spawnReparentedOrphan(genericScript);

      // 4) Marker-tragender Prozess mit LEBENDEM Eltern (PPID = dieser Worker, ≠1)
      //    → simuliert einen aktiven Schwester-Lauf → darf NIE angefasst werden.
      const liveChild = spawn(process.execPath, [serverScript], { stdio: "ignore" });
      liveChild.unref();
      const livePid = liveChild.pid!;
      spawnedPids.add(livePid);

      // Auf echtes Reparenting der drei Waisen warten.
      await Promise.all([
        waitForReparent(serverOrphan),
        waitForReparent(chromiumOrphan),
        waitForReparent(foreignOrphan),
      ]);

      // Der Live-Eltern-Prozess muss eine PPID ≠ 1 haben (Eltern = dieser Worker).
      const liveInfo = findProc(livePid);
      expect(liveInfo, "Live-Eltern-Prozess nicht in der Prozessliste gefunden").toBeDefined();
      expect(liveInfo!.ppid).not.toBe(1);

      // Sweep mit ECHTER Enumeration + ECHTEM Kill, Kandidatenkreis aber auf die
      // eigenen PIDs begrenzt (Hermetik). minAgeMs:0 hebt die Altersgrenze auf
      // (die frisch gestarteten Waisen wären sonst geschützt — der Force-Pfad des
      // Unblock-CLI tut genau das).
      const ownPids = new Set([serverOrphan, chromiumOrphan, foreignOrphan, livePid]);
      const killed: number[] = [];
      const result = sweepOrphanProcesses({
        minAgeMs: 0,
        selfPid: process.pid,
        enumerate: () => enumerateProcesses().filter((p) => ownPids.has(p.pid)),
        kill: (pid, signal) => {
          if (pid > 0) killed.push(pid);
          process.kill(pid, signal);
        },
      });

      // Genau die beiden Waisen wurden als gekillt verbucht.
      expect(result.failed).toEqual([]);
      expect(result.killed.map((o) => o.pid).sort((a, b) => a - b)).toEqual(
        [serverOrphan, chromiumOrphan].sort((a, b) => a - b),
      );
      // Einzel-Kill traf NUR die beiden Waisen (kein Fremd-/Live-Prozess).
      expect(killed.sort((a, b) => a - b)).toEqual(
        [serverOrphan, chromiumOrphan].sort((a, b) => a - b),
      );

      // Die Waisen sind real tot.
      await Promise.all([waitForDeath(serverOrphan), waitForDeath(chromiumOrphan)]);

      // Fremd- und Live-Eltern-Prozess leben unangetastet weiter.
      expect(isAlive(foreignOrphan), "Fremdprozess wurde fälschlich gekillt").toBe(true);
      expect(isAlive(livePid), "Live-Eltern-Prozess wurde fälschlich gekillt").toBe(true);
    },
    30000,
  );
});
