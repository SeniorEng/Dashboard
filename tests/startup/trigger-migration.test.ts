/**
 * A1 — Die versionierte GoBD-Trigger-Migration baut EXAKT das, was der
 * Startup-Renderer zur Laufzeit baut.
 *
 * Das ist die Gegenprobe, an der die ganze Stufe hängt: Wird die Startup-DDL
 * später abgeschaltet (Track C), ist diese Migration die einzige Quelle der
 * GoBD-/Unveränderlichkeits-Trigger. Weicht sie auch nur in Timing, Event,
 * Level, Zielfunktion oder Funktionsrumpf ab, fällt der Schutz still teilweise
 * weg — und die Reproduzierbarkeits-Gegenprobe in A3 würde es erst dort zeigen.
 *
 * Strategie: Die Test-DB ist bereits vom Renderer gebaut (der App-Server hat
 * `runStartupTasks()` durchlaufen). Wir lesen die normalisierten Definitionen
 * aus dem Katalog (`pg_get_functiondef` / `pg_get_triggerdef`), spielen die
 * Migration in einer Transaktion darüber und lesen erneut. Ist die Migration
 * deckungsgleich, ändert sie NICHTS — Objekt für Objekt, von PostgreSQL selbst
 * normalisiert, nicht per Textvergleich. Danach `ROLLBACK`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  ALL_STARTUP_TRIGGER_FUNCTIONS,
  ALL_STARTUP_TRIGGER_SPECS,
  ORPHANED_TRIGGER_FUNCTIONS,
} from "../../server/startup/trigger-registry";
import {
  renderTriggerMigration,
  TRIGGER_MIGRATION_PATH,
} from "../../scripts/generate-trigger-migration";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Normalisierte Funktions-Definitionen aus dem Katalog. */
async function functionDefs(tx: Tx): Promise<Map<string, string>> {
  const res = await tx.execute(sql`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_type rt ON rt.oid = p.prorettype
    WHERE n.nspname = current_schema() AND rt.typname = 'trigger'
  `);
  return new Map(
    (res.rows as Array<Record<string, unknown>>).map((r) => [
      r.proname as string,
      r.def as string,
    ]),
  );
}

/** Normalisierte Trigger-Definitionen, geschlüsselt auf `tabelle.trigger`. */
async function triggerDefs(tx: Tx): Promise<Map<string, string>> {
  const res = await tx.execute(sql`
    SELECT c.relname AS tbl, t.tgname,
           pg_get_triggerdef(t.oid) || ' [tgenabled=' || t.tgenabled::text || ']' AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = current_schema()
  `);
  return new Map(
    (res.rows as Array<Record<string, unknown>>).map((r) => [
      `${r.tbl as string}.${r.tgname as string}`,
      r.def as string,
    ]),
  );
}

let migrationSql = "";

beforeAll(() => {
  migrationSql = readFileSync(join(process.cwd(), TRIGGER_MIGRATION_PATH), "utf8");
});

describe("A1 — Trigger-Migration == Startup-Renderer", () => {
  it("die eingecheckte Migration entspricht der SSoT (kein Handbetrieb)", () => {
    // Ohne diesen Pin könnte die Datei hinter der Registry zurückfallen und die
    // Migration schleichend eine andere Menge bauen als der Renderer.
    expect(
      migrationSql,
      `${TRIGGER_MIGRATION_PATH} weicht von der SSoT ab — ` +
        `neu erzeugen: npx tsx scripts/generate-trigger-migration.ts`,
    ).toBe(renderTriggerMigration());
  });

  it("enthält alle 11 Funktionen, 16 Trigger und die 3 Orphan-Drops", () => {
    for (const fn of ALL_STARTUP_TRIGGER_FUNCTIONS) {
      expect(migrationSql, `Funktion fehlt: ${fn.name}`).toContain(
        `CREATE OR REPLACE FUNCTION ${fn.name}()`,
      );
    }
    for (const spec of ALL_STARTUP_TRIGGER_SPECS) {
      expect(migrationSql, `Trigger fehlt: ${spec.name}`).toContain(
        `CREATE TRIGGER ${spec.name}`,
      );
    }
    for (const orphan of ORPHANED_TRIGGER_FUNCTIONS) {
      expect(migrationSql, `Orphan-Drop fehlt: ${orphan}`).toContain(
        `DROP FUNCTION IF EXISTS ${orphan}();`,
      );
    }
    // Kein CASCADE — ein haengendes Objekt MUSS die Migration scheitern lassen.
    // Geprueft wird das AUSGEFUEHRTE SQL, nicht der Kommentar, der genau das
    // erklaert (der enthaelt das Wort naturgemaess).
    const executedSql = migrationSql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(
      executedSql,
      "Die Migration darf kein CASCADE ausfuehren — ein haengendes Objekt soll " +
        "sie scheitern lassen, nicht still mitgerissen werden.",
    ).not.toContain("CASCADE");
  });

  it("KEIN invoices-UPDATE-Trigger (Status quo, eigenes Ticket)", () => {
    // `invoice_line_items` hat UPDATE und DELETE, `invoices` nur DELETE. Die
    // Asymmetrie ist beabsichtigt: ein hier ergänzter UPDATE-Trigger stünde in
    // der Migration, aber nicht in Prod — und die A3-Gegenprobe würde fallen.
    const invoicesUpdate = ALL_STARTUP_TRIGGER_SPECS.filter(
      (s) => s.table === "invoices" && s.events.includes("UPDATE"),
    );
    expect(
      invoicesUpdate.map((s) => s.name),
      "Die Migration darf keinen invoices-UPDATE-Trigger anlegen, den Prod nicht hat.",
    ).toEqual([]);
  });

  it("angewendet auf die vom Renderer gebaute DB ändert sie NICHTS (Objekt für Objekt)", async () => {
    const before = { fns: new Map<string, string>(), trgs: new Map<string, string>() };
    const after = { fns: new Map<string, string>(), trgs: new Map<string, string>() };

    await db
      .transaction(async (tx) => {
        before.fns = await functionDefs(tx);
        before.trgs = await triggerDefs(tx);

        await tx.execute(sql.raw(migrationSql));

        after.fns = await functionDefs(tx);
        after.trgs = await triggerDefs(tx);

        // Immer zurückrollen: der Test darf die geteilte Worker-DB nicht verändern.
        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "__rollback__") throw err;
      });

    // Sanity: wir haben überhaupt etwas gemessen.
    expect(before.fns.size).toBeGreaterThanOrEqual(ALL_STARTUP_TRIGGER_FUNCTIONS.length);
    expect(before.trgs.size).toBeGreaterThanOrEqual(ALL_STARTUP_TRIGGER_SPECS.length);

    expect(
      [...after.fns.keys()].sort(),
      "Die Migration legt andere Funktionen an als der Renderer.",
    ).toEqual([...before.fns.keys()].sort());
    expect(
      [...after.trgs.keys()].sort(),
      "Die Migration legt andere Trigger an als der Renderer.",
    ).toEqual([...before.trgs.keys()].sort());

    for (const [name, def] of before.fns) {
      expect(after.fns.get(name), `Funktionsrumpf weicht ab: ${name}`).toBe(def);
    }
    for (const [key, def] of before.trgs) {
      expect(after.trgs.get(key), `Trigger-Bindung weicht ab: ${key}`).toBe(def);
    }
  });

  it("baut aus dem NICHTS wieder exakt denselben Stand (Neubau-Fall)", async () => {
    // Der Vorher/Nachher-Vergleich oben pinnt „aendert nichts". Dieser Test
    // pinnt „baut alles aus dem Nichts" — die Aussage, die Track C braucht,
    // wenn die Startup-DDL aus ist und die Migration allein laeuft. Er faengt
    // damit z.B. eine Migration, die nur DROPs enthaelt, eine falsche
    // Reihenfolge (Trigger vor seiner Funktion) oder ein Statement, das nur
    // gegen bereits vorhandene Objekte funktioniert.
    //
    // Was er NICHT kann, und das ist wichtig zu wissen: ein Loch in der SSoT
    // selbst. Faellt eine Spec ganz heraus, legt der Renderer den Trigger
    // ebenfalls nicht an — dann fehlt er im Ausgangsstand UND im Neubau, und
    // beide Seiten sind sich einig. Der nicht-zirkulaere Anker dagegen sind die
    // Verhaltenstests (tests/audit-log-immutable.test.ts,
    // tests/gobd-table-immutability.test.ts,
    // tests/budget-transactions-immutability.test.ts), die pruefen, dass die
    // Schreibversuche tatsaechlich scheitern.
    let before = { fns: new Map<string, string>(), trgs: new Map<string, string>() };

    await db
      .transaction(async (tx) => {
        before = { fns: await functionDefs(tx), trgs: await triggerDefs(tx) };

        for (const [key] of before.trgs) {
          const [tbl, name] = key.split(".");
          await tx.execute(sql.raw(`DROP TRIGGER "${name}" ON "${tbl}"`));
        }
        for (const name of before.fns.keys()) {
          await tx.execute(sql.raw(`DROP FUNCTION "${name}"()`));
        }
        expect((await triggerDefs(tx)).size, "Aufraeumen unvollstaendig").toBe(0);
        expect((await functionDefs(tx)).size, "Aufraeumen unvollstaendig").toBe(0);

        await tx.execute(sql.raw(migrationSql));

        const rebuilt = { fns: await functionDefs(tx), trgs: await triggerDefs(tx) };
        expect(
          [...rebuilt.trgs.keys()].sort(),
          "Die Migration allein baut nicht dieselben Trigger.",
        ).toEqual([...before.trgs.keys()].sort());
        expect(
          [...rebuilt.fns.keys()].sort(),
          "Die Migration allein baut nicht dieselben Funktionen.",
        ).toEqual([...before.fns.keys()].sort());
        for (const [k, def] of before.trgs) {
          expect(rebuilt.trgs.get(k), `Neubau weicht ab (Trigger): ${k}`).toBe(def);
        }
        for (const [k, def] of before.fns) {
          expect(rebuilt.fns.get(k), `Neubau weicht ab (Funktion): ${k}`).toBe(def);
        }

        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "__rollback__") throw err;
      });
  });

  it("droppt die verwaisten budget_ledger-Funktionen", async () => {
    await db
      .transaction(async (tx) => {
        // Prod-Zustand herstellen: die drei Orphans existieren dort noch.
        for (const orphan of ORPHANED_TRIGGER_FUNCTIONS) {
          await tx.execute(sql.raw(`
            CREATE OR REPLACE FUNCTION ${orphan}() RETURNS trigger AS $$
            BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`));
        }
        const withOrphans = await functionDefs(tx);
        for (const orphan of ORPHANED_TRIGGER_FUNCTIONS) {
          expect(withOrphans.has(orphan), `Setup fehlgeschlagen: ${orphan}`).toBe(true);
        }

        await tx.execute(sql.raw(migrationSql));

        const afterFns = await functionDefs(tx);
        for (const orphan of ORPHANED_TRIGGER_FUNCTIONS) {
          expect(
            afterFns.has(orphan),
            `Verwaiste Funktion nicht gedroppt: ${orphan}`,
          ).toBe(false);
        }
        // Die lebenden bleiben unangetastet.
        for (const fn of ALL_STARTUP_TRIGGER_FUNCTIONS) {
          expect(afterFns.has(fn.name), `Lebende Funktion verloren: ${fn.name}`).toBe(true);
        }

        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "__rollback__") throw err;
      });
  });
});
