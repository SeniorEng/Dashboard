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
  assertEphemeralDbForWrite,
  assertEphemeralTestDb,
  evaluateTestDbTarget,
  NON_EPHEMERAL_WRITE_ENV,
} from "../../scripts/lib/ephemeral-db-guard";

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

// Follow-up aus dem Gate-2-Review zu PR #20: die schreibenden Entrypoints
// (drizzle-kit push, beide Test-Seeds) lasen `DATABASE_URL` vorher ungeprüft.
// Sie teilen sich jetzt die Allow-List des Testlauf-Guards plus EINE
// Absichtserklärung für die legitimen Nicht-Test-Wege.
describe("assertEphemeralDbForWrite", () => {
  it("blockiert eine geerbte Dev-DB-URL und nennt den Entrypoint", () => {
    expect(() =>
      assertEphemeralDbForWrite("ci-seed-superadmin", { DATABASE_URL: DEV_URL }),
    ).toThrow(/ci-seed-superadmin/);
  });

  it("blockiert auch, wenn DATABASE_URL ganz fehlt", () => {
    expect(() => assertEphemeralDbForWrite("drizzle-kit push", {})).toThrow(
      /NICHT-Wegwerf-Datenbank/,
    );
  });

  it("nennt die drei legitimen Wege in der Meldung", () => {
    const run = () =>
      assertEphemeralDbForWrite("drizzle-kit push", { DATABASE_URL: DEV_URL });
    expect(run).toThrow(/scripts\/migrate\.sh/);
    expect(run).toThrow(/npm run db:push/);
    expect(run).toThrow(/npm run db:reseed-dev/);
  });

  it("lässt CI und eine direkte cc_test_-DATABASE_URL durch", () => {
    expect(() =>
      assertEphemeralDbForWrite("x", { DATABASE_URL: EPHEMERAL_URL }),
    ).not.toThrow();
    expect(() => assertEphemeralDbForWrite("x", { CI: "true" })).not.toThrow();
  });

  // BEWUSST enger als `evaluateTestDbTarget`: dessen Pfad 2 beantwortet „läuft
  // dieser TESTLAUF gegen Wegwerf-DBs?". Für einen Schreibvorgang zählt aber,
  // wo ER landet — und das steht in DATABASE_URL. Ein Rest `TEST_DATABASE_URLS`
  // aus einem früheren Orchestrator-Lauf darf keinen Push auf die Dev-Prod-Kopie
  // freischalten.
  it("lässt sich NICHT von einem Rest-TEST_DATABASE_URLS freischalten", () => {
    expect(
      evaluateTestDbTarget({
        TEST_DATABASE_URLS: EPHEMERAL_URL,
        DATABASE_URL: DEV_URL,
      }).ok,
    ).toBe(true); // Testlauf-Frage: erlaubt
    expect(() =>
      assertEphemeralDbForWrite("drizzle-kit push", {
        TEST_DATABASE_URLS: EPHEMERAL_URL,
        DATABASE_URL: DEV_URL,
      }),
    ).toThrow(/NICHT-Wegwerf-Datenbank/); // Schreib-Frage: blockiert
  });

  it("lässt den erklärten Nicht-Test-Schreibzugriff durch (migrate.sh, db:push, reseed)", () => {
    expect(() =>
      assertEphemeralDbForWrite("drizzle-kit push", {
        DATABASE_URL: "postgres://user:pw@prod-host:5432/careconnect",
        [NON_EPHEMERAL_WRITE_ENV]: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertEphemeralDbForWrite("ci-seed-superadmin", {
        DATABASE_URL: DEV_URL,
        [NON_EPHEMERAL_WRITE_ENV]: "1",
      }),
    ).not.toThrow();
  });

  it("akzeptiert nur exakt '1' als Absichtserklärung", () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(() =>
        assertEphemeralDbForWrite("drizzle-kit push", {
          DATABASE_URL: DEV_URL,
          [NON_EPHEMERAL_WRITE_ENV]: value,
        }),
      ).toThrow(/NICHT-Wegwerf-Datenbank/);
    }
  });

  it("der Marker hebelt den Testlauf-Guard NICHT aus", () => {
    expect(() =>
      assertEphemeralTestDb({
        DATABASE_URL: DEV_URL,
        [NON_EPHEMERAL_WRITE_ENV]: "1",
      }),
    ).toThrow(/NICHT-Wegwerf-Datenbank/);
  });
});
