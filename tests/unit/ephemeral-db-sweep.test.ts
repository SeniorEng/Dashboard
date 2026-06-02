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
  parseDbCreatedAt,
  selectOrphanLogsToDelete,
  shouldDropOrphan,
  type LogFileInfo,
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
