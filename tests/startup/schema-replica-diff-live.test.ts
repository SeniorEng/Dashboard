/**
 * Task #1342 / #1367 — Live-Integrationstest für den Publish-Schema-Diff-Detektor.
 *
 * Die reine Diff-/Vertrags-/Bestätigungs-Logik ist DB-frei unit-getestet
 * (`tests/unit/schema-replica-diff.test.ts`). Der TATSÄCHLICHE DB-Fetch-Pfad
 * (`fetchSchemaSnapshot` + `detectDestructiveSchemaDiffAgainstProd`, die über
 * `pg` echtes Postgres lesen) hatte bisher keinen Test — eine Regression im SQL,
 * das die Tabellen-/Spalten-Metadaten liest, wäre unbemerkt geblieben.
 *
 * Strategie (wie der Ephemeral-DB-Pattern in tests/startup/*): wir provisionieren
 * ZWEI echte Wegwerf-Datenbanken auf demselben lokalen Postgres-Server —
 *   - `target` (= Dev/Drizzle-Ziel des Publish) und
 *   - `prod`   (= read-only Prod-Replica) MIT je einer Extra-Tabelle/-Spalte —
 * fahren den vollen Detektor dagegen und prüfen über den ECHTEN DB-Lese-Pfad:
 *   1. Drop-Treffer: gedroppte Tabelle UND gedroppte Spalte werden gemeldet
 *      (in `prod`, fehlt im Ziel) — Task #1342.
 *   2. Kein Fehlalarm bei ADDITIVER Änderung: eine Tabelle und eine Spalte, die
 *      NUR im Ziel existieren, tauchen NICHT in `drops` auf — Task #1367 (a).
 *   3. Expand-Migrate-Contract-Verletzung: eine noch von einem Startup-
 *      Migrations-Pfad referenzierte Tabelle (`STARTUP_MIGRATION_REFERENCED_TABLES`),
 *      die in `prod` existiert und im Ziel fehlt, erscheint in
 *      `contractViolations` — Task #1367 (b).
 *
 * Skippt sauber, wenn keine DB verfügbar ist oder `CREATE DATABASE` nicht
 * gelingt (z.B. fehlende Rechte / Neon-Proxy ohne per-DB-Routing in CI).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  detectDestructiveSchemaDiffAgainstProd,
  resolveSchemaSnapshotSsl,
  STARTUP_MIGRATION_REFERENCED_TABLES,
} from "../../script/schema-replica-diff.mjs";

const ADMIN_URL = process.env.DATABASE_URL;

// Sicherheit: ausschließlich `cc_test_`-Wegwerf-DBs (wie der Orchestrator).
const suffix = `${process.pid.toString(36)}_${randomBytes(4).toString("hex")}`;
const TARGET_DB = `cc_test_schemadiff_target_${suffix}`;
const PROD_DB = `cc_test_schemadiff_prod_${suffix}`;

// Eine noch von einem Startup-Migrations-Pfad referenzierte Tabelle (Contract).
const REFERENCED_TABLE = STARTUP_MIGRATION_REFERENCED_TABLES[0];

function urlForDb(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: ADMIN_URL!,
    ssl: resolveSchemaSnapshotSsl(ADMIN_URL!),
  });
  await client.connect();
  return client;
}

async function runSql(connectionString: string, statements: string[]): Promise<void> {
  const client = new pg.Client({
    connectionString,
    ssl: resolveSchemaSnapshotSsl(connectionString),
  });
  await client.connect();
  try {
    for (const stmt of statements) await client.query(stmt);
  } finally {
    await client.end();
  }
}

let ready = false;
let setupError: unknown = null;

beforeAll(async () => {
  if (!ADMIN_URL) {
    setupError = new Error("DATABASE_URL nicht gesetzt");
    return;
  }
  let admin: pg.Client | null = null;
  try {
    admin = await adminClient();
    // CREATE DATABASE läuft nicht in einer Transaktion → Einzel-Statements.
    await admin.query(`DROP DATABASE IF EXISTS "${TARGET_DB}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS "${PROD_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TARGET_DB}"`);
    await admin.query(`CREATE DATABASE "${PROD_DB}"`);

    // Ziel-Schema (= Dev/Drizzle): die Basis PLUS eine rein ADDITIVE Tabelle und
    // Spalte, die in der Prod-Replica NICHT existieren (Task #1367 (a)). Diese
    // dürfen NICHT als Drop gemeldet werden — sie sind ein normaler Expand-Schritt.
    await runSql(urlForDb(TARGET_DB), [
      `CREATE TABLE kept_table (id integer PRIMARY KEY, kept_col text, target_only_col text)`,
      `CREATE TABLE target_only_table (id integer PRIMARY KEY)`,
    ]);

    // Prod-Replica: Basis + EINE Extra-Spalte + EINE Extra-Tabelle + eine noch
    // referenzierte Tabelle (würde Expand-Migrate-Contract verletzen).
    await runSql(urlForDb(PROD_DB), [
      `CREATE TABLE kept_table (id integer PRIMARY KEY, kept_col text, extra_col text)`,
      `CREATE TABLE dropped_table (id integer PRIMARY KEY)`,
      `CREATE TABLE "${REFERENCED_TABLE}" (id integer PRIMARY KEY, hourly_rate_cents integer)`,
    ]);
    ready = true;
  } catch (e) {
    setupError = e;
  } finally {
    if (admin) await admin.end().catch(() => {});
  }
});

afterAll(async () => {
  if (!ADMIN_URL) return;
  let admin: pg.Client | null = null;
  try {
    admin = await adminClient();
    await admin.query(`DROP DATABASE IF EXISTS "${TARGET_DB}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS "${PROD_DB}" WITH (FORCE)`);
  } catch {
    // Best-effort Cleanup; der Ephemeral-Sweep räumt cc_test_-DBs ohnehin auf.
  } finally {
    if (admin) await admin.end().catch(() => {});
  }
});

describe("Task #1342 — detectDestructiveSchemaDiffAgainstProd (live, zwei DBs)", () => {
  it("liest das echte Schema und meldet gedroppte Tabelle + Spalte", async (ctx) => {
    if (!ready) {
      ctx.skip(
        `Keine zweite DB verfügbar — Setup übersprungen (${
          setupError instanceof Error ? setupError.message : String(setupError)
        })`,
      );
      return;
    }

    const result = await detectDestructiveSchemaDiffAgainstProd({
      targetUrl: urlForDb(TARGET_DB),
      prodUrl: urlForDb(PROD_DB),
    });

    expect(result.available).toBe(true);

    // Gedroppte Tabelle (in Prod, fehlt im Ziel) wird erkannt.
    expect(result.droppedTables).toContain("dropped_table");
    // Gedroppte Spalte (in Prod, fehlt im Ziel) wird erkannt.
    expect(result.droppedColumns).toContainEqual({
      table: "kept_table",
      column: "extra_col",
    });
    // Behaltene Tabelle/Spalte werden NICHT fälschlich als Drop gemeldet.
    expect(result.droppedTables).not.toContain("kept_table");
    expect(result.droppedColumns).not.toContainEqual({
      table: "kept_table",
      column: "kept_col",
    });

    // Die noch referenzierte Tabelle erscheint als Drop UND als Contract-Verletzung.
    expect(result.droppedTables).toContain(REFERENCED_TABLE);
    expect(result.contractViolations).toContain(REFERENCED_TABLE);

    // Flache Drop-Liste enthält beide Drop-Arten.
    expect(result.drops).toContainEqual({ table: "dropped_table" });
    expect(result.drops).toContainEqual({ table: "kept_table", column: "extra_col" });
  });

  it("Task #1367 (a): meldet additive Tabelle/Spalte (nur im Ziel) NICHT als Drop", async (ctx) => {
    if (!ready) {
      ctx.skip("Keine zweite DB verfügbar");
      return;
    }

    // Das Ziel enthält `target_only_table` und `kept_table.target_only_col`, die
    // beide in der Prod-Replica fehlen. Eine rein additive Erweiterung des Schemas
    // ist KEIN destruktiver Schritt — der Detektor darf hier NICHT Alarm schlagen.
    const result = await detectDestructiveSchemaDiffAgainstProd({
      targetUrl: urlForDb(TARGET_DB),
      prodUrl: urlForDb(PROD_DB),
    });

    expect(result.available).toBe(true);

    // Die additive Tabelle taucht weder als gedroppte Tabelle noch in der flachen
    // Drop-Liste auf.
    expect(result.droppedTables).not.toContain("target_only_table");
    expect(result.drops).not.toContainEqual({ table: "target_only_table" });

    // Die additive Spalte taucht weder als gedroppte Spalte noch in der flachen
    // Drop-Liste auf.
    expect(result.droppedColumns).not.toContainEqual({
      table: "kept_table",
      column: "target_only_col",
    });
    expect(result.drops).not.toContainEqual({
      table: "kept_table",
      column: "target_only_col",
    });

    // Additive Elemente lösen auch keine (vermeintliche) Contract-Verletzung aus.
    expect(result.contractViolations).not.toContain("target_only_table");
  });

  it("Task #1367 (b): meldet eine noch referenzierte, nur in Prod existierende Tabelle als Contract-Verletzung", async (ctx) => {
    if (!ready) {
      ctx.skip("Keine zweite DB verfügbar");
      return;
    }

    // `REFERENCED_TABLE` steht in STARTUP_MIGRATION_REFERENCED_TABLES und existiert
    // nur in der Prod-Replica. Ihr Wegfall im Ziel würde Expand-Migrate-Contract
    // verletzen (ein noch gelesener Startup-Migrations-Pfad verlöre seine Quelle).
    const result = await detectDestructiveSchemaDiffAgainstProd({
      targetUrl: urlForDb(TARGET_DB),
      prodUrl: urlForDb(PROD_DB),
    });

    expect(result.available).toBe(true);
    // Erscheint sowohl als gedroppte Tabelle …
    expect(result.droppedTables).toContain(REFERENCED_TABLE);
    // … als auch explizit als Contract-Verletzung.
    expect(result.contractViolations).toContain(REFERENCED_TABLE);
  });

  it("meldet KEINE Drops, wenn das Ziel-Schema die Prod-Replica vollständig enthält", async (ctx) => {
    if (!ready) {
      ctx.skip("Keine zweite DB verfügbar");
      return;
    }

    // Ziel gegen sich selbst diffen → identisches Schema → keine Drops.
    const result = await detectDestructiveSchemaDiffAgainstProd({
      targetUrl: urlForDb(TARGET_DB),
      prodUrl: urlForDb(TARGET_DB),
    });

    expect(result.available).toBe(true);
    expect(result.droppedTables).toEqual([]);
    expect(result.droppedColumns).toEqual([]);
    expect(result.contractViolations).toEqual([]);
  });
});
