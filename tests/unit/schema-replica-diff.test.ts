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
  isSameDatabase,
  connectionHost,
  resolveSchemaSnapshotSsl,
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

/**
 * Der Diff vergleicht ZWEI Schnappschüsse. Sind beide Verbindungen dieselbe
 * Datenbank — etwa weil die Dev-URL versehentlich auch in `PROD_DATABASE_URL`
 * steht —, ist das Ergebnis per Konstruktion leer, und „0 Drops" liest sich wie
 * „nichts zu befürchten".
 *
 * **Das ist dieselbe Klasse wie der übersprungene Replica-Diff vom 17.09.2026**
 * (`preflight-publish-fail-closed.test.ts`), nur eine Stufe subtiler: die
 * Prüfung läuft diesmal sogar, sie vergleicht nur nichts.
 */
describe("Identität der zwei Verbindungen (6hWvMvpxpJFFjwQG)", () => {
  it("ID-1 – gleicher Host UND gleiche Datenbank heisst: es wurde nichts verglichen", () => {
    expect(
      isSameDatabase(
        { host: "ep-x.eu-central-1.aws.neon.tech", database: "neondb" },
        { host: "ep-x.eu-central-1.aws.neon.tech", database: "neondb" },
      ),
    ).toBe(true);
  });

  it("ID-2 – gleicher Datenbank-NAME auf verschiedenen Hosts ist der Normalfall", () => {
    // Dev und Prod heissen bei Neon beide `neondb`. Ein Riegel auf den Namen
    // allein würde jeden echten Vergleich blockieren.
    expect(
      isSameDatabase(
        { host: "ep-dev.eu-central-1.aws.neon.tech", database: "neondb" },
        { host: "ep-prod.eu-central-1.aws.neon.tech", database: "neondb" },
      ),
    ).toBe(false);
  });

  it("ID-3 – gleicher Host, verschiedene Datenbanken ist ebenfalls ein echter Vergleich", () => {
    expect(
      isSameDatabase(
        { host: "db.example.com:5432", database: "careconnect_dev" },
        { host: "db.example.com:5432", database: "careconnect" },
      ),
    ).toBe(false);
  });

  it("ID-4 – der Host kommt ohne Benutzer und Passwort heraus", () => {
    // Die Identität wird GEMELDET (CLAUDE.md: Host + current_database()), der
    // Connection-String nie. Ein Host-Helfer, der das Passwort mitführt, würde
    // es genau dorthin tragen, wo es nicht hingehört.
    const host = connectionHost("postgres://nutzer:GEHEIM@db.example.com:5432/neondb?sslmode=require");
    expect(host).toBe("db.example.com:5432");
    expect(host).not.toContain("GEHEIM");
    expect(host).not.toContain("nutzer");
  });

  it("ID-5 – ein unlesbarer Connection-String wird benannt, nicht verschluckt", () => {
    expect(connectionHost("das ist keine url")).toMatch(/unlesbar/);
  });
});

/**
 * Die SSL-Entscheidung — und warum sie einen eigenen Waechter bekommt.
 *
 * Der Docblock der Funktion sagt seit jeher, sie mache „den echten
 * DB-Fetch-Pfad integration-testbar". Tatsaechlich sah sie nur nach
 * `sslmode=disable`, und weder `.env.test.local` noch der CI-`postgres:16`
 * tragen diesen Parameter. Ergebnis: erzwungenes SSL gegen einen Server ohne
 * SSL, `beforeAll` warf, und
 * `tests/startup/schema-replica-diff-live.test.ts` uebersprang sich still —
 * **5 von 5 Faellen skipped, ohne eine einzige rote Zeile** (gemessen
 * 18.09.2026). Der einzige Test des echten DB-Lesepfads des
 * Publish-Drop-Detektors lief also nie.
 *
 * Ein uebersprungener Test ist kein gruener Test. Diese Faelle halten die
 * Bedingung fest, unter der er ueberhaupt laufen kann.
 */
describe("SSL-Entscheidung (schema-replica-diff)", () => {
  it("SSL-1 – Prod-Neon mit sslmode=require bekommt tolerantes SSL", () => {
    expect(
      resolveSchemaSnapshotSsl("postgres://u:p@ep-prod.eu-central-1.aws.neon.tech/neondb?sslmode=require"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("SSL-2 – ein entfernter Host OHNE sslmode bekommt weiterhin SSL", () => {
    // Die konservative Seite bleibt unveraendert: nur der Loopback-Fall aendert
    // sich. Faellt das hier, waere die Prod-Verbindung schwaecher geworden.
    expect(
      resolveSchemaSnapshotSsl("postgres://u:p@ep-prod.eu-central-1.aws.neon.tech/neondb"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("SSL-3 – localhost ohne sslmode bekommt KEIN SSL (sonst skippt der Live-Test)", () => {
    expect(resolveSchemaSnapshotSsl("postgres://postgres:postgres@localhost:5432/cc_test_x")).toBe(false);
    expect(resolveSchemaSnapshotSsl("postgres://postgres:postgres@127.0.0.1:5432/cc_test_x")).toBe(false);
  });

  it("SSL-4 – ausdrueckliches sslmode schlaegt die Host-Regel", () => {
    // Wer auf dem Loopback ausdruecklich TLS verlangt, bekommt es; wer
    // ausdruecklich keins will, bekommt keins — auch entfernt.
    expect(
      resolveSchemaSnapshotSsl("postgres://u:p@localhost:5432/db?sslmode=require"),
    ).toEqual({ rejectUnauthorized: false });
    expect(resolveSchemaSnapshotSsl("postgres://u:p@ferner.example.com:5432/db?sslmode=disable")).toBe(false);
  });

  it("SSL-5 – ein unlesbarer String bleibt auf der sicheren Seite", () => {
    expect(resolveSchemaSnapshotSsl("kein connection string")).toEqual({ rejectUnauthorized: false });
  });
});
