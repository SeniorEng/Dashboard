/**
 * Task #902 — Unit-Tests für die reine Entscheidungslogik des Wegwerf-Test-DB-
 * Sweeps. `shouldDropOrphan` / `parseDbCreatedAt` entscheiden, welche
 * verbindungslosen `cc_test_%`-Waisen gedroppt werden dürfen. Diese Tests pinnen
 * die Sicherheits-Garantien fest: nur eigenes Präfix, Altersgrenze schützt
 * frisch provisionierte Schwester-DBs, Alt-Namen ohne Zeitstempel bleiben
 * unangetastet, und `--force` (minAgeMs=0) hebt die Altersgrenze auf.
 */
import { describe, it, expect } from "vitest";
import {
  DB_PREFIX,
  ORPHAN_MIN_AGE_MS,
  isTestServerLogName,
  liveRunIdsFromProcesses,
  parseArtifactRunId,
  parseDbCreatedAt,
  selectOrphanArtifactsToDelete,
  selectOrphanLogsToDelete,
  shouldDropOrphan,
  type ArtifactInfo,
  type LogFileInfo,
  type ProcInfo,
} from "../../scripts/lib/ephemeral-db-sweep.ts";

const NOW = 10_000_000_000_000; // fixer „Jetzt"-Anker

function dbName(createdAtMs: number, suffix = "12345_abcdef01"): string {
  return `${DB_PREFIX}${createdAtMs.toString(36)}_${suffix}`;
}

describe("parseDbCreatedAt", () => {
  it("parst den base36-Zeitstempel aus einem Wegwerf-DB-Namen", () => {
    const created = NOW - 60_000;
    expect(parseDbCreatedAt(dbName(created))).toBe(created);
  });

  it("liefert null für DBs ohne unser Präfix", () => {
    expect(parseDbCreatedAt("some_other_db")).toBeNull();
  });

  it("liefert null für Alt-Namen ohne parsebaren Zeitstempel", () => {
    expect(parseDbCreatedAt(`${DB_PREFIX}_legacy`)).toBeNull();
    expect(parseDbCreatedAt(`${DB_PREFIX}!!!_x`)).toBeNull();
  });
});

describe("shouldDropOrphan", () => {
  it("droppt eine ausreichend alte, eigene Wegwerf-DB", () => {
    const old = NOW - (ORPHAN_MIN_AGE_MS + 1);
    expect(shouldDropOrphan(dbName(old), NOW, ORPHAN_MIN_AGE_MS)).toBe(true);
  });

  it("schützt eine frisch provisionierte DB innerhalb des Altersfensters", () => {
    const fresh = NOW - 1_000;
    expect(shouldDropOrphan(dbName(fresh), NOW, ORPHAN_MIN_AGE_MS)).toBe(false);
  });

  it("fasst fremde DBs niemals an", () => {
    expect(shouldDropOrphan("postgres", NOW, 0)).toBe(false);
    expect(shouldDropOrphan("cc_prod_db", NOW, 0)).toBe(false);
  });

  it("lässt Alt-Namen ohne Zeitstempel bei aktiver Altersgrenze unberührt", () => {
    expect(shouldDropOrphan(`${DB_PREFIX}_legacy`, NOW, ORPHAN_MIN_AGE_MS)).toBe(false);
  });

  it("droppt mit minAgeMs<=0 (force) jede eigene verbindungslose DB, auch ohne Zeitstempel", () => {
    expect(shouldDropOrphan(dbName(NOW), NOW, 0)).toBe(true);
    expect(shouldDropOrphan(`${DB_PREFIX}_legacy`, NOW, 0)).toBe(true);
  });

  it("behandelt exakt-an-der-Grenze als droppbar (>=)", () => {
    const exactly = NOW - ORPHAN_MIN_AGE_MS;
    expect(shouldDropOrphan(dbName(exactly), NOW, ORPHAN_MIN_AGE_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task #904 — Sweep der verwaisten per-Worker-Server-Logs.
// ---------------------------------------------------------------------------
function logFile(name: string, mtimeMs: number): LogFileInfo {
  return { name, mtimeMs };
}

describe("isTestServerLogName", () => {
  it("matcht nur exakt test-server-<port>.log", () => {
    expect(isTestServerLogName("test-server-5050.log")).toBe(true);
    expect(isTestServerLogName("test-server-1.log")).toBe(true);
  });

  it("lehnt alles andere ab", () => {
    expect(isTestServerLogName("test-server-.log")).toBe(false);
    expect(isTestServerLogName("test-server-abc.log")).toBe(false);
    expect(isTestServerLogName("test-server-5050.log.bak")).toBe(false);
    expect(isTestServerLogName("server-5050.log")).toBe(false);
    expect(isTestServerLogName("something.log")).toBe(false);
    expect(isTestServerLogName(".env.local")).toBe(false);
  });
});

describe("selectOrphanLogsToDelete", () => {
  it("löscht ausreichend alte Logs jenseits der Keep-Recent-Grenze", () => {
    const files = [
      logFile("test-server-1.log", NOW - 60 * 60_000),
      logFile("test-server-2.log", NOW - 50 * 60_000),
      logFile("test-server-3.log", NOW - 40 * 60_000),
    ];
    // keepRecent=0 → alle alten werden gelöscht.
    expect(new Set(selectOrphanLogsToDelete(files, NOW, ORPHAN_MIN_AGE_MS, 0))).toEqual(
      new Set(["test-server-1.log", "test-server-2.log", "test-server-3.log"]),
    );
  });

  it("behält immer die N jüngsten Logs (auch wenn alt)", () => {
    const files = [
      logFile("test-server-1.log", NOW - 60 * 60_000),
      logFile("test-server-2.log", NOW - 50 * 60_000),
      logFile("test-server-3.log", NOW - 40 * 60_000),
    ];
    // keepRecent=2 → die 2 jüngsten (3, 2) bleiben; nur das älteste (1) fällt.
    expect(selectOrphanLogsToDelete(files, NOW, ORPHAN_MIN_AGE_MS, 2)).toEqual([
      "test-server-1.log",
    ]);
  });

  it("schützt frisch beschriebene Logs eines aktiven Schwester-Laufs", () => {
    const files = [
      logFile("test-server-1.log", NOW - 1_000),
      logFile("test-server-2.log", NOW - 60 * 60_000),
    ];
    // keepRecent=0, aber Port 1 ist innerhalb der Altersgrenze → nur Port 2 fällt.
    expect(selectOrphanLogsToDelete(files, NOW, ORPHAN_MIN_AGE_MS, 0)).toEqual([
      "test-server-2.log",
    ]);
  });

  it("ignoriert Dateien, die nicht dem Log-Muster entsprechen", () => {
    const files = [
      logFile("test-server-1.log", NOW - 60 * 60_000),
      logFile("random.log", NOW - 60 * 60_000),
      logFile(".env.local", NOW - 60 * 60_000),
    ];
    expect(selectOrphanLogsToDelete(files, NOW, ORPHAN_MIN_AGE_MS, 0)).toEqual([
      "test-server-1.log",
    ]);
  });

  it("löscht mit minAgeMs<=0 (force) auch frische Logs jenseits der Keep-Grenze", () => {
    const files = [
      logFile("test-server-1.log", NOW - 1_000),
      logFile("test-server-2.log", NOW - 500),
    ];
    // sort desc: Port 2 (jünger) zuerst, dann Port 1. keepRecent=1 behält Port 2.
    expect(selectOrphanLogsToDelete(files, NOW, 0, 1)).toEqual([
      "test-server-1.log",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task #1492 — Sweep der verwaisten per-Run-Build-Artefakte
// (`.local/test-server-<runId>.cjs` + `.local/test-client-<runId>/`).
// Schutz ist die runId-Lebendigkeit (laufender Server-Prozess) + Altersgrenze.
// ---------------------------------------------------------------------------
function artifact(name: string, runId: string, kind: "bundle" | "client", mtimeMs: number): ArtifactInfo {
  return { name, runId, kind, mtimeMs };
}

function proc(command: string): ProcInfo {
  return { pid: 1234, ppid: 1, etimeSec: 60, command };
}

describe("parseArtifactRunId", () => {
  it("erkennt Server-Bundles und liefert runId + kind", () => {
    expect(parseArtifactRunId("test-server-mqzg32ph_318_6996850b.cjs")).toEqual({
      runId: "mqzg32ph_318_6996850b",
      kind: "bundle",
    });
  });

  it("erkennt Client-Verzeichnisse und liefert runId + kind", () => {
    expect(parseArtifactRunId("test-client-mqzg32ph_318_6996850b")).toEqual({
      runId: "mqzg32ph_318_6996850b",
      kind: "client",
    });
  });

  it("matcht NICHT die per-Worker-Server-Logs (test-server-<port>.log)", () => {
    expect(parseArtifactRunId("test-server-5050.log")).toBeNull();
  });

  it("fasst unbeteiligte Dateien nie an", () => {
    expect(parseArtifactRunId(".env.local")).toBeNull();
    expect(parseArtifactRunId("server.cjs")).toBeNull();
    expect(parseArtifactRunId("test-results")).toBeNull();
  });
});

describe("liveRunIdsFromProcesses", () => {
  it("zieht die runId aus der Kommandozeile eines laufenden gebündelten Servers", () => {
    const procs = [
      proc("node .local/test-server-aaa_1_bbb.cjs"),
      proc("npx tsx scripts/with-ephemeral-db.ts 5050 npx vitest run"),
    ];
    expect(liveRunIdsFromProcesses(procs)).toEqual(new Set(["aaa_1_bbb"]));
  });

  it("liefert eine leere Menge, wenn kein gebündelter Server läuft", () => {
    expect(liveRunIdsFromProcesses([proc("node something-else.js")])).toEqual(
      new Set(),
    );
  });
});

describe("selectOrphanArtifactsToDelete", () => {
  it("löscht ausreichend alte Artefakte ohne lebende runId (Bundle UND Client)", () => {
    const arts = [
      artifact("test-server-dead.cjs", "dead", "bundle", NOW - 60 * 60_000),
      artifact("test-client-dead", "dead", "client", NOW - 60 * 60_000),
    ];
    const deleted = selectOrphanArtifactsToDelete(arts, new Set(), NOW, ORPHAN_MIN_AGE_MS);
    expect(new Set(deleted.map((a) => a.name))).toEqual(
      new Set(["test-server-dead.cjs", "test-client-dead"]),
    );
  });

  it("schützt Bundle UND Client eines laufenden Laufs — auch wenn das Bundle alt ist", () => {
    // Bundle-mtime wird beim Lauf NICHT erneuert: ein 30-Min-Lauf hat ein altes
    // Bundle, ist aber via runId-Lebendigkeit geschützt.
    const arts = [
      artifact("test-server-live.cjs", "live", "bundle", NOW - 30 * 60_000),
      artifact("test-client-live", "live", "client", NOW - 30 * 60_000),
    ];
    const deleted = selectOrphanArtifactsToDelete(
      arts,
      new Set(["live"]),
      NOW,
      ORPHAN_MIN_AGE_MS,
    );
    expect(deleted).toEqual([]);
  });

  it("schützt frisch gestartete Läufe über die Altersgrenze, auch ohne sichtbaren Prozess", () => {
    const arts = [
      artifact("test-server-fresh.cjs", "fresh", "bundle", NOW - 1_000),
    ];
    expect(selectOrphanArtifactsToDelete(arts, new Set(), NOW, ORPHAN_MIN_AGE_MS)).toEqual([]);
  });

  it("löscht im Force-Modus (minAgeMs<=0) Waisen jenseits des Bootstrap-Bodens, schützt aber laufende runIds weiter", () => {
    const arts = [
      // älter als der 60s-Boden → im Force-Modus droppbar
      artifact("test-server-orphan.cjs", "orphan", "bundle", NOW - 5 * 60_000),
      artifact("test-server-live.cjs", "live", "bundle", NOW - 5 * 60_000),
    ];
    const deleted = selectOrphanArtifactsToDelete(arts, new Set(["live"]), NOW, 0);
    expect(deleted.map((a) => a.name)).toEqual(["test-server-orphan.cjs"]);
  });

  it("schützt im Force-Modus ein gerade startendes Bundle innerhalb des Bootstrap-Bodens (Server noch nicht in ps)", () => {
    const arts = [
      artifact("test-server-booting.cjs", "booting", "bundle", NOW - 1_000),
    ];
    // minAgeMs=0 (force), aber das Artefakt ist jünger als ARTIFACT_FORCE_FLOOR_MS
    // und die runId ist noch nicht via ps sichtbar → trotzdem geschützt.
    expect(selectOrphanArtifactsToDelete(arts, new Set(), NOW, 0)).toEqual([]);
  });
});
