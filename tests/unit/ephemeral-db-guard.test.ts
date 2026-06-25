/**
 * Task #1427 — Unit-Tests für die reine Entscheidungslogik des Wegwerf-DB-Guards.
 * `evaluateTestDbTarget` / `assertEphemeralTestDb` entscheiden, ob ein Testlauf
 * gegen eine erlaubte Ephemeral-/Wegwerf-DB läuft. Diese Tests pinnen die drei
 * erlaubten Pfade fest (CI, Orchestrator-Variablen, `cc_test_`-DATABASE_URL) und
 * stellen sicher, dass eine geerbte Dev-DB-URL hart blockiert wird.
 */
import { describe, it, expect } from "vitest";
import { DB_PREFIX } from "../../scripts/lib/ephemeral-db-sweep.ts";
import {
  assertEphemeralTestDb,
  evaluateTestDbTarget,
} from "../helpers/ephemeral-db-guard";

const DEV_URL = "postgres://user:pw@helium/heliumdb";
const EPHEMERAL_URL = `postgres://user:pw@localhost:5432/${DB_PREFIX}abc123_w0`;

describe("evaluateTestDbTarget", () => {
  it("erlaubt CI (CI=true) trotz Nicht-cc_test_-DB-Namen", () => {
    const result = evaluateTestDbTarget({
      CI: "true",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/careconnect",
    });
    expect(result.ok).toBe(true);
  });

  it("erlaubt den Orchestrator-Pfad (TEST_DATABASE_URLS gesetzt)", () => {
    const result = evaluateTestDbTarget({
      TEST_DATABASE_URLS: EPHEMERAL_URL,
      DATABASE_URL: DEV_URL, // selbst eine Dev-URL ist egal, wenn Orchestrator-Var da ist
    });
    expect(result.ok).toBe(true);
  });

  it("erlaubt eine direkte cc_test_-DATABASE_URL", () => {
    const result = evaluateTestDbTarget({ DATABASE_URL: EPHEMERAL_URL });
    expect(result.ok).toBe(true);
  });

  it("blockiert eine geerbte Dev-DB-URL ohne Orchestrator/CI", () => {
    const result = evaluateTestDbTarget({ DATABASE_URL: DEV_URL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.dbName).toBe("heliumdb");
  });

  it("blockiert, wenn DATABASE_URL ganz fehlt", () => {
    const result = evaluateTestDbTarget({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.dbName).toBeNull();
  });

  it("behandelt leeres TEST_DATABASE_URLS nicht als Orchestrator", () => {
    const result = evaluateTestDbTarget({
      TEST_DATABASE_URLS: "   ",
      DATABASE_URL: DEV_URL,
    });
    expect(result.ok).toBe(false);
  });
});

describe("assertEphemeralTestDb", () => {
  it("wirft mit klarer deutscher Meldung bei Dev-DB", () => {
    expect(() => assertEphemeralTestDb({ DATABASE_URL: DEV_URL })).toThrow(
      /NICHT-Wegwerf-Datenbank/,
    );
  });

  it("wirft NICHT bei erlaubter Ephemeral-DB", () => {
    expect(() =>
      assertEphemeralTestDb({ DATABASE_URL: EPHEMERAL_URL }),
    ).not.toThrow();
  });

  it("wirft NICHT in CI", () => {
    expect(() => assertEphemeralTestDb({ CI: "true" })).not.toThrow();
  });
});
