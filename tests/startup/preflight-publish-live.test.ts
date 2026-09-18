/**
 * Die Publish-Checkliste, gegen ZWEI echte Datenbanken gefahren.
 *
 * ── Warum es diese Datei gibt ────────────────────────────────────────────
 * `tests/unit/preflight-publish-fail-closed.test.ts` prüft den FEHLER-Pfad:
 * ohne Prod-Verbindung darf nichts grün werden. Der grüne Pfad war dagegen
 * nie gemessen — und genau an ihn hat Alrik für den ersten Prod-Lauf zwei
 * Bedingungen geknüpft (18.09.2026):
 *
 *   1. Die Ausgabe MUSS zeigen, was verglichen wurde.
 *   2. Ein grünes Ergebnis ohne sichtbaren Vergleich gilt nicht als
 *      bestanden, sondern als **ungeklärt**.
 *
 * Bedingung 2 lässt sich nur am grünen Lauf prüfen. Ein Test, der bloss den
 * roten Fall fährt, wäre für sie vakuum-wahr — dieselbe Falle, in die in
 * dieser Serie schon CB-5, PO-3 und der „Ziel gegen sich selbst"-Fall im
 * Replica-Diff gelaufen sind.
 *
 * Deshalb hier zwei echte Wegwerf-DBs und die Checkliste als Subprozess, so
 * wie der Operator sie sieht.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { resolveSchemaSnapshotSsl } from "../../script/schema-replica-diff.mjs";

const REPO = path.resolve(__dirname, "../..");
const ADMIN_URL = process.env.DATABASE_URL;

const suffix = `${process.pid.toString(36)}_${randomBytes(4).toString("hex")}`;
const ZIEL_DB = `cc_test_preflight_ziel_${suffix}`;
const PROD_DB = `cc_test_preflight_prod_${suffix}`;

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

/** Die Checkliste so fahren, wie der Operator sie fährt. */
function checkliste(env: NodeJS.ProcessEnv): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["script/preflight-publish.mjs"],
      { cwd: REPO, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === "number" ? err.code : 0,
          text: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

let ready = false;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  let admin: pg.Client | null = null;
  try {
    admin = await adminClient();
    await admin.query(`DROP DATABASE IF EXISTS "${ZIEL_DB}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS "${PROD_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${ZIEL_DB}"`);
    await admin.query(`CREATE DATABASE "${PROD_DB}"`);

    // Prod ist eine echte TEILMENGE des Ziels: nichts zu droppen, also der
    // grüne Fall — und zwar aus dem richtigen Grund, nicht weil nichts
    // verglichen wurde.
    await runSql(urlForDb(ZIEL_DB), [
      `CREATE TABLE kunden (id integer PRIMARY KEY, name text, neue_spalte text)`,
      `CREATE TABLE neue_tabelle (id integer PRIMARY KEY)`,
    ]);
    await runSql(urlForDb(PROD_DB), [
      `CREATE TABLE kunden (id integer PRIMARY KEY, name text)`,
    ]);
    ready = true;
  } catch {
    ready = false;
  } finally {
    if (admin) await admin.end().catch(() => {});
  }
});

afterAll(async () => {
  if (!ADMIN_URL) return;
  let admin: pg.Client | null = null;
  try {
    admin = await adminClient();
    await admin.query(`DROP DATABASE IF EXISTS "${ZIEL_DB}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS "${PROD_DB}" WITH (FORCE)`);
  } catch {
    // Best-effort; der Ephemeral-Sweep räumt `cc_test_`-DBs ohnehin auf.
  } finally {
    if (admin) await admin.end().catch(() => {});
  }
});

describe("Publish-Checkliste, grüner Pfad gegen zwei echte DBs (6hWvMvpxpJFFjwQG)", () => {
  it("PL-0 – die Fixture steht (sonst misst diese Datei nichts)", async (ctx) => {
    // Ohne diese Zusage könnten alle folgenden Fälle aus dem falschen Grund
    // grün sein. Der Live-Replica-Test hat genau so ein Jahr lang still
    // übersprungen.
    if (!ADMIN_URL) return ctx.skip();
    expect(ready, "zwei Wegwerf-DBs liessen sich nicht anlegen").toBe(true);
  });

  it("PL-1 – grün geht nur MIT sichtbarem Vergleich (Alriks Bedingung 1+2)", async (ctx) => {
    if (!ready) return ctx.skip();

    const { code, text } = await checkliste({
      DATABASE_URL: urlForDb(ZIEL_DB),
      PROD_DATABASE_URL: urlForDb(PROD_DB),
    });

    // Der Lauf muss durchgehen — sonst prüft der Rest den falschen Zweig.
    expect(code, `Checkliste rot, obwohl nichts zu droppen ist:\n${text}`).toBe(0);

    // Bedingung 1: die Ausgabe zeigt, WAS verglichen wurde.
    expect(text).toMatch(/Verglichen wurde/);
    expect(text, "der Ziel-Datenbankname fehlt in der Ausgabe").toContain(ZIEL_DB);
    expect(text, "der Prod-Datenbankname fehlt in der Ausgabe").toContain(PROD_DB);

    // Bedingung 2 als Invariante formuliert: WENN der Lauf durchgeht, DANN
    // steht der Vergleich da. Die Antezedenz ist hier erfüllt (code === 0
    // oben geprüft), der Fall ist also nicht vakuum-wahr.
    expect(code === 0 && /Verglichen wurde/.test(text)).toBe(true);

    // Und das Passwort darf dabei nirgends auftauchen.
    expect(text).not.toContain(new URL(ADMIN_URL!).password);
  });

  it("PL-2 – dieselbe DB auf beiden Seiten ist ungeklärt, nicht bestanden", async (ctx) => {
    if (!ready) return ctx.skip();

    // Der praktisch häufige Fehlgriff: die Dev-URL steht versehentlich auch in
    // PROD_DATABASE_URL. Vorher kam „keine destruktiven Änderungen" heraus.
    const { code, text } = await checkliste({
      DATABASE_URL: urlForDb(ZIEL_DB),
      PROD_DATABASE_URL: urlForDb(ZIEL_DB),
    });

    expect(code, "dieselbe DB auf beiden Seiten darf nicht durchgehen").not.toBe(0);
    expect(text).toMatch(/dieselbe Datenbank/);
    expect(text).toMatch(/NICHT bereit für Publish/);
    expect(text, "„keine destruktiven Änderungen“ wäre hier eine Falschaussage")
      .not.toMatch(/Keine destruktiven Schema-Änderungen erkannt/);
  });

  it("PL-3 – ein echter Drop wird benannt, nicht nur gezählt", async (ctx) => {
    if (!ready) return ctx.skip();

    // Gegenrichtung zu PL-1: die Checkliste muss auch das Gegenteil können.
    // Prod hat hier eine Tabelle und eine Spalte, die das Ziel nicht mehr hat.
    await runSql(urlForDb(PROD_DB), [
      `CREATE TABLE alte_tabelle (id integer PRIMARY KEY)`,
      `ALTER TABLE kunden ADD COLUMN alte_spalte text`,
    ]);

    const { code, text } = await checkliste({
      DATABASE_URL: urlForDb(ZIEL_DB),
      PROD_DATABASE_URL: urlForDb(PROD_DB),
    });

    expect(code, "anstehende Drops müssen blockieren").not.toBe(0);
    expect(text).toContain("DROP TABLE alte_tabelle");
    expect(text).toContain("DROP COLUMN kunden.alte_spalte");
    // Auch hier: der Vergleich bleibt sichtbar.
    expect(text).toMatch(/Verglichen wurde/);
  });
});
