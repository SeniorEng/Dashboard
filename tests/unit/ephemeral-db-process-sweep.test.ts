/**
 * Task #1489 — Unit-Tests für die reine Entscheidungslogik des Prozess-Orphan-
 * Sweeps + PID-Preflights. Diese Tests pinnen die Sicherheits-Garantien fest:
 * nur eindeutig markierte Test-Prozesse, nur an init reparentete Waisen (PPID 1),
 * niemals der eigene Prozess oder init, Altersgrenze schützt frische Prozesse
 * eines Schwester-Laufs — und der PID-Preflight blockiert nur bei wirklich hoher
 * Auslastung, niemals bei unbekanntem/unbegrenztem Limit (fail-safe).
 */
import { describe, it, expect } from "vitest";
import {
  ORPHAN_PROC_MIN_AGE_MS,
  TEST_CHROMIUM_PROC_MARKER,
  classifyTestProcess,
  evaluatePidPreflight,
  parsePsOutput,
  selectOrphanProcesses,
  sweepOrphanProcesses,
  type ProcInfo,
} from "../../scripts/lib/ephemeral-db-sweep.ts";

const SELF_PID = 4242;
const SERVER_CMD = "node .local/test-server-abc123_99_deadbeef.cjs";
const CHROMIUM_CMD = `/usr/bin/chromium --headless --user-data-dir=/tmp/${TEST_CHROMIUM_PROC_MARKER}xyz`;

function proc(partial: Partial<ProcInfo> & { pid: number }): ProcInfo {
  return {
    ppid: 1,
    etimeSec: 9999,
    command: SERVER_CMD,
    ...partial,
  };
}

describe("classifyTestProcess", () => {
  it("erkennt den gebündelten per-Worker-Test-Server am .cjs-Bundle-Pfad", () => {
    expect(classifyTestProcess(SERVER_CMD)).toBe("server");
  });

  it("erkennt das test-spezifische Chromium am User-Data-Dir-Marker", () => {
    expect(classifyTestProcess(CHROMIUM_CMD)).toBe("chromium");
  });

  it("fasst dev-/prod-Chromium ohne test-Marker nie an", () => {
    expect(
      classifyTestProcess("/usr/bin/chromium --user-data-dir=/tmp/careconnect-chromium-7f3a"),
    ).toBeNull();
  });

  it("liefert null für unbeteiligte Fremdprozesse", () => {
    expect(classifyTestProcess("node server/index.ts")).toBeNull();
    expect(classifyTestProcess("psql cc_test_foo")).toBeNull();
    expect(classifyTestProcess("/usr/lib/postgresql/bin/postgres -D /data")).toBeNull();
  });
});

describe("selectOrphanProcesses", () => {
  it("wählt einen alten, an init reparenteten Test-Server als Waise", () => {
    const out = selectOrphanProcesses([proc({ pid: 100 })], SELF_PID, ORPHAN_PROC_MIN_AGE_MS);
    expect(out).toEqual([{ pid: 100, kind: "server", command: SERVER_CMD }]);
  });

  it("wählt ein an init reparentetes test-Chromium als Waise", () => {
    const out = selectOrphanProcesses(
      [proc({ pid: 101, command: CHROMIUM_CMD })],
      SELF_PID,
      ORPHAN_PROC_MIN_AGE_MS,
    );
    expect(out).toEqual([{ pid: 101, kind: "chromium", command: CHROMIUM_CMD }]);
  });

  it("schützt einen Prozess mit lebendem Eltern (PPID ≠ 1 → Schwester-Lauf aktiv)", () => {
    const out = selectOrphanProcesses(
      [proc({ pid: 102, ppid: 555 })],
      SELF_PID,
      ORPHAN_PROC_MIN_AGE_MS,
    );
    expect(out).toEqual([]);
  });

  it("fasst niemals den eigenen Prozess oder init (pid<=1) an", () => {
    const out = selectOrphanProcesses(
      [proc({ pid: SELF_PID }), proc({ pid: 1 }), proc({ pid: 0 })],
      SELF_PID,
      0,
    );
    expect(out).toEqual([]);
  });

  it("schützt einen frisch gestarteten Prozess innerhalb des Altersfensters", () => {
    const out = selectOrphanProcesses(
      [proc({ pid: 103, etimeSec: 1 })],
      SELF_PID,
      ORPHAN_PROC_MIN_AGE_MS,
    );
    expect(out).toEqual([]);
  });

  it("hebt die Altersgrenze bei minAgeMs=0 auf (--force)", () => {
    const out = selectOrphanProcesses([proc({ pid: 104, etimeSec: 0 })], SELF_PID, 0);
    expect(out.map((o) => o.pid)).toEqual([104]);
  });

  it("ignoriert Fremdprozesse, auch wenn sie an init hängen", () => {
    const out = selectOrphanProcesses(
      [proc({ pid: 105, command: "node server/index.ts", ppid: 1 })],
      SELF_PID,
      0,
    );
    expect(out).toEqual([]);
  });
});

describe("parsePsOutput", () => {
  it("parst pid/ppid/etimes/args aus `ps -eo pid=,ppid=,etimes=,args=`", () => {
    const stdout = [
      "  100     1   3600 node .local/test-server-abc.cjs",
      " 1234  1000     12 /usr/bin/some-app --flag",
      "",
      "  garbage line without numbers",
    ].join("\n");
    const procs = parsePsOutput(stdout);
    expect(procs).toEqual([
      { pid: 100, ppid: 1, etimeSec: 3600, command: "node .local/test-server-abc.cjs" },
      { pid: 1234, ppid: 1000, etimeSec: 12, command: "/usr/bin/some-app --flag" },
    ]);
  });

  it("klemmt negative etimes auf 0 (fail-safe)", () => {
    const procs = parsePsOutput("  7    1   -5 node x");
    expect(procs[0]?.etimeSec).toBe(0);
  });
});

describe("sweepOrphanProcesses (Ergebnis-Form)", () => {
  // Schützt die vom Unblock-CLI gelesene Form { killed, failed } vor Regression
  // (der CLI-Summary-Pfad las früher ein nicht existierendes `.skipped`).
  it("liefert genau { killed, failed } und füllt killed bei dry-run", () => {
    const procs: ProcInfo[] = [
      { pid: 100, ppid: 1, etimeSec: 9999, command: SERVER_CMD },
      { pid: 101, ppid: 1, etimeSec: 9999, command: CHROMIUM_CMD },
    ];
    const result = sweepOrphanProcesses({
      dryRun: true,
      selfPid: SELF_PID,
      enumerate: () => procs,
      kill: () => {
        throw new Error("dry-run darf nie killen");
      },
    });
    expect(Object.keys(result).sort()).toEqual(["failed", "killed"]);
    expect(result.killed.map((o) => o.pid).sort()).toEqual([100, 101]);
    expect(result.failed).toEqual([]);
  });

  it("verbucht Kill-Fehler unter failed (nicht skipped)", () => {
    const result = sweepOrphanProcesses({
      selfPid: SELF_PID,
      enumerate: () => [{ pid: 200, ppid: 1, etimeSec: 9999, command: SERVER_CMD }],
      kill: (pid) => {
        // Gruppen-Kill (negativ) tolerieren, Einzel-Kill scheitern lassen.
        if (pid > 0) throw new Error("EPERM");
      },
    });
    expect(result.killed).toEqual([]);
    expect(result.failed.map((o) => o.pid)).toEqual([200]);
  });
});

describe("evaluatePidPreflight", () => {
  it("besteht, wenn die Auslastung unter dem Schwellwert liegt", () => {
    const r = evaluatePidPreflight({ current: 400, max: 1024 }, 0.8);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBeCloseTo(400 / 1024);
  });

  it("blockiert, wenn die Auslastung den Schwellwert erreicht/übersteigt", () => {
    const r = evaluatePidPreflight({ current: 900, max: 1024 }, 0.8);
    expect(r.ok).toBe(false);
  });

  it("besteht immer, wenn das Limit unbekannt/unbegrenzt ist (fail-safe)", () => {
    expect(evaluatePidPreflight({ current: 9999, max: null }, 0.8).ok).toBe(true);
    expect(evaluatePidPreflight({ current: 9999, max: 0 }, 0.8).ok).toBe(true);
  });
});
