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
  parseDbCreatedAt,
  shouldDropOrphan,
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
