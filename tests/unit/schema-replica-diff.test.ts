/**
 * Task #1339 — Reiner Destruktiv-Detektor für den Publish-Schema-Diff.
 *
 * Prüft die DB-freie Kernlogik des Schema-vs-Prod-Replica-Detektors:
 *   - `computeDestructiveSchemaDiff`: Tabellen/Spalten, die in Prod existieren,
 *     aber im Ziel-Schema (Dev/Drizzle) fehlen ⇒ würden vom Publish gedroppt.
 *   - `checkExpandMigrateContract`: ein Table-Drop, der noch von einem Startup-
 *     Migrations-Pfad referenziert wird, verletzt Expand-Migrate-Contract.
 *   - Per-DROP-Bestätigung: `dropKey` / `partitionAcknowledgedDrops` / `parseAckList`.
 */
import { describe, it, expect } from "vitest";
import {
  computeDestructiveSchemaDiff,
  flattenDestructiveDiff,
  checkExpandMigrateContract,
  dropKey,
  describeDrop,
  partitionAcknowledgedDrops,
  parseAckList,
  STARTUP_MIGRATION_REFERENCED_TABLES,
} from "../../script/schema-replica-diff.mjs";

describe("Task #1339 — computeDestructiveSchemaDiff", () => {
  it("meldet eine Tabelle als Drop, wenn sie in Prod, aber nicht im Ziel existiert", () => {
    const target = { prices: ["id", "cents"] };
    const prod = { prices: ["id", "cents"], service_rates: ["id", "hourly_rate_cents"] };
    const diff = computeDestructiveSchemaDiff(target, prod);
    expect(diff.droppedTables).toEqual(["service_rates"]);
    expect(diff.droppedColumns).toEqual([]);
  });

  it("meldet eine Spalte als Drop, wenn sie in Prod, aber nicht im Ziel existiert", () => {
    const target = { prices: ["id", "cents"] };
    const prod = { prices: ["id", "cents", "legacy_amount"] };
    const diff = computeDestructiveSchemaDiff(target, prod);
    expect(diff.droppedTables).toEqual([]);
    expect(diff.droppedColumns).toEqual([{ table: "prices", column: "legacy_amount" }]);
  });

  it("meldet nichts, wenn das Ziel alle Prod-Tabellen/Spalten enthält (auch additiv)", () => {
    const target = { prices: ["id", "cents", "origin"], neue_tabelle: ["id"] };
    const prod = { prices: ["id", "cents"] };
    const diff = computeDestructiveSchemaDiff(target, prod);
    expect(diff.droppedTables).toEqual([]);
    expect(diff.droppedColumns).toEqual([]);
  });

  it("flacht beide Diff-Hälften zu einer Drop-Liste ab", () => {
    const drops = flattenDestructiveDiff({
      droppedTables: ["service_rates"],
      droppedColumns: [{ table: "prices", column: "legacy_amount" }],
    });
    expect(drops).toEqual([
      { table: "service_rates" },
      { table: "prices", column: "legacy_amount" },
    ]);
  });
});

describe("Task #1339 — Expand-Migrate-Contract", () => {
  it("verletzt den Contract, wenn eine noch referenzierte Tabelle gedroppt wird", () => {
    const drops = [{ table: "service_rates" }, { table: "irgendwas_altes" }];
    const violations = checkExpandMigrateContract(drops);
    expect(violations).toEqual(["service_rates"]);
  });

  it("ist sauber, wenn nur nicht-referenzierte Tabellen gedroppt werden", () => {
    const drops = [{ table: "irgendwas_altes" }];
    expect(checkExpandMigrateContract(drops)).toEqual([]);
  });

  it("wertet einen Spalten-Drop einer referenzierten Tabelle NICHT als Contract-Verletzung", () => {
    const drops = [{ table: "service_rates", column: "hourly_rate_cents" }];
    expect(checkExpandMigrateContract(drops)).toEqual([]);
  });

  it("kennt die drei Alt-Preis-Tabellen als referenziert", () => {
    expect(STARTUP_MIGRATION_REFERENCED_TABLES).toContain("service_rates");
    expect(STARTUP_MIGRATION_REFERENCED_TABLES).toContain("customer_contract_rates");
    expect(STARTUP_MIGRATION_REFERENCED_TABLES).toContain("customer_service_prices");
  });
});

describe("Task #1339 — Per-DROP-Bestätigung", () => {
  it("erzeugt stabile, unterscheidbare Keys für Table- und Spalten-Drops", () => {
    expect(dropKey({ table: "service_rates" })).toBe("table:service_rates");
    expect(dropKey({ table: "prices", column: "legacy_amount" })).toBe(
      "column:prices.legacy_amount",
    );
  });

  it("beschreibt Drops menschenlesbar", () => {
    expect(describeDrop({ table: "service_rates" })).toBe("DROP TABLE service_rates");
    expect(describeDrop({ table: "prices", column: "legacy_amount" })).toBe(
      "DROP COLUMN prices.legacy_amount",
    );
  });

  it("parst PUBLISH_ACK_DROPS aus Komma-/Whitespace-Liste", () => {
    expect(parseAckList("table:a, column:b.c\ntable:d")).toEqual([
      "table:a",
      "column:b.c",
      "table:d",
    ]);
    expect(parseAckList("")).toEqual([]);
    expect(parseAckList(undefined)).toEqual([]);
  });

  it("teilt Drops in bestätigte und unbestätigte auf", () => {
    const drops = [
      { table: "service_rates" },
      { table: "prices", column: "legacy_amount" },
    ];
    const { acknowledged, unacknowledged } = partitionAcknowledgedDrops(drops, [
      "table:service_rates",
    ]);
    expect(acknowledged).toEqual([{ table: "service_rates" }]);
    expect(unacknowledged).toEqual([{ table: "prices", column: "legacy_amount" }]);
  });
});
