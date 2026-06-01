/**
 * Task #895 — Tests für das verlässliche Budget-Migrations-Framework.
 *
 *  1. (Unit) `assertNoNewConservationViolations` toleriert vorbestehende
 *     Verletzungen, blockiert aber NEU eingeführte (Topf + Kreuzcheck).
 *  2. (Integration) Eine Migration läuft genau EINMAL: erster Lauf `applied`,
 *     zweiter Lauf `skipped` (Ledger-Gating), migrate-Body kein zweites Mal.
 *  3. (Integration) Wirft die Migration, rollt die GESAMTE Transaktion zurück:
 *     kein Daten-Schreibvorgang persistiert, KEIN Ledger-Eintrag.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { ensureMigrationLedger } from "../server/startup/ensure-migration-ledger";
import {
  runGuardedBudgetMigration,
  assertNoNewConservationViolations,
  BudgetConservationViolationError,
} from "../server/startup/budget-migration-runner";
import type { ConservationResult } from "../server/lib/budget-conservation";

const SCRATCH = "_test895_scratch";
const TEST_MIGRATION_NAMES = ["__test895_runonce", "__test895_throws"] as const;

function conservation(potViolationKeys: string[], crossDetails: string[] = []): ConservationResult {
  return {
    checkedPairs: potViolationKeys.length,
    potRows: [],
    potViolationKeys,
    crossViolations: crossDetails.length,
    crossDetails,
    total: potViolationKeys.length + crossDetails.length,
  };
}

async function ledgerCount(name: string): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM budget_migrations WHERE name = ${name}`);
  return Number((r.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0);
}

async function scratchCount(): Promise<number> {
  const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS cnt FROM ${SCRATCH}`));
  return Number((r.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0);
}

async function clearTestMigrations(): Promise<void> {
  for (const name of TEST_MIGRATION_NAMES) {
    await db.execute(sql`DELETE FROM budget_migrations WHERE name = ${name}`);
  }
}

describe("Budget-Migrations-Framework: Conservation-Guard (Unit)", () => {
  it("toleriert vorbestehende Verletzungen (kein Throw)", () => {
    const pre = conservation(["1|entlastungsbetrag_45b"]);
    const post = conservation(["1|entlastungsbetrag_45b"]);
    expect(() => assertNoNewConservationViolations("m", pre, post)).not.toThrow();
  });

  it("wirft bei NEU eingeführter Topf-Überziehung", () => {
    const pre = conservation([]);
    const post = conservation(["7|verhinderungspflege_39"]);
    expect(() => assertNoNewConservationViolations("m", pre, post)).toThrow(
      BudgetConservationViolationError,
    );
  });

  it("wirft bei NEU eingeführter Kreuzcheck-Verletzung", () => {
    const pre = conservation([], []);
    const post = conservation([], ["Reservation #1 orphan", "Ledger #2 dangling"]);
    expect(() => assertNoNewConservationViolations("m", pre, post)).toThrow(
      BudgetConservationViolationError,
    );
  });

  it("wirft, wenn eine alte Kreuzcheck-Verletzung durch eine ANDERE ersetzt wird (Count gleich)", () => {
    const pre = conservation([], ["Reservation #1 orphan"]);
    const post = conservation([], ["Ledger #2 dangling"]);
    expect(() => assertNoNewConservationViolations("m", pre, post)).toThrow(
      BudgetConservationViolationError,
    );
  });

  it("toleriert UNVERÄNDERTE Kreuzcheck-Verletzungen (identisch in pre und post)", () => {
    const pre = conservation([], ["Reservation #1 orphan"]);
    const post = conservation([], ["Reservation #1 orphan"]);
    expect(() => assertNoNewConservationViolations("m", pre, post)).not.toThrow();
  });
});

describe("Budget-Migrations-Framework: Runner (Integration)", () => {
  beforeAll(async () => {
    await ensureMigrationLedger();
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id serial PRIMARY KEY)`));
  });

  afterEach(async () => {
    await clearTestMigrations();
    await db.execute(sql.raw(`TRUNCATE ${SCRATCH}`));
  });

  afterAll(async () => {
    await clearTestMigrations();
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${SCRATCH}`));
  });

  it("läuft genau einmal (zweiter Lauf wird per Ledger übersprungen)", async () => {
    let runs = 0;
    const migrate = async () => {
      runs++;
      return { changed: 1 };
    };

    const first = await runGuardedBudgetMigration({
      name: "__test895_runonce",
      conservationCheck: false,
      migrate,
    });
    const second = await runGuardedBudgetMigration({
      name: "__test895_runonce",
      conservationCheck: false,
      migrate,
    });

    expect(first).toBe("applied");
    expect(second).toBe("skipped");
    expect(runs).toBe(1);
    expect(await ledgerCount("__test895_runonce")).toBe(1);
  });

  it("ist nebenläufig exactly-once (zwei parallele Läufe → migrate-Body genau einmal, ein Ledger-Eintrag)", async () => {
    let runs = 0;
    const migrate = async (tx: import("../server/lib/db").Tx) => {
      runs++;
      await tx.execute(sql.raw(`INSERT INTO ${SCRATCH} DEFAULT VALUES`));
      return { changed: 1 };
    };

    const [a, b] = await Promise.all([
      runGuardedBudgetMigration({ name: "__test895_runonce", conservationCheck: false, migrate }),
      runGuardedBudgetMigration({ name: "__test895_runonce", conservationCheck: false, migrate }),
    ]);

    expect([a, b].sort()).toEqual(["applied", "skipped"]);
    expect(runs).toBe(1);
    expect(await scratchCount()).toBe(1);
    expect(await ledgerCount("__test895_runonce")).toBe(1);
  });

  it("rollt bei Exception die gesamte Transaktion zurück (kein Ledger-Eintrag, keine Schreibwirkung)", async () => {
    await expect(
      runGuardedBudgetMigration({
        name: "__test895_throws",
        conservationCheck: false,
        migrate: async (tx) => {
          await tx.execute(sql.raw(`INSERT INTO ${SCRATCH} DEFAULT VALUES`));
          throw new Error("absichtlicher Migrationsfehler");
        },
      }),
    ).rejects.toThrow("absichtlicher Migrationsfehler");

    expect(await scratchCount()).toBe(0);
    expect(await ledgerCount("__test895_throws")).toBe(0);
  });
});
