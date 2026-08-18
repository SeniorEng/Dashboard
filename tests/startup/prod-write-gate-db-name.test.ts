import { describe, it, expect } from "vitest";
import { currentDatabaseName, dbHostOf } from "../../server/scripts/lib/prod-write-gate";

/**
 * Der einzige Teil des Prod-Gates, der eine echte Verbindung braucht.
 *
 * ── Warum es diesen Fall gibt ───────────────────────────────────────────
 * Der neue Diskriminator liest den Datenbanknamen per `SELECT
 * current_database()`. Ob die Antwortform stimmt, hängt am Treiber — und die
 * Unit-Fälle mocken `server/lib/db` genau an dieser Stelle. Sie prüfen damit
 * die Annahme, die sie belegen sollen.
 *
 * Hier läuft es gegen die echte Wegwerf-DB: `drizzle-orm/node-postgres` liefert
 * ein `QueryResult` mit `.rows`, und die Extraktion muss daraus den Namen
 * ziehen, der auch in der `DATABASE_URL` steht.
 *
 * NICHT gedeckt: `DB_DRIVER=neon` — das ist der Prod-Pfad, und er braucht den
 * Neon-WS-Proxy, den der Routine-Ablauf bewusst abwählt. `@neondatabase/serverless`
 * bildet dieselbe `Pool`-API nach, aber gemessen ist das hier nicht.
 */
describe("currentDatabaseName gegen einen echten Treiber", () => {
  it("liefert denselben Namen, den die DATABASE_URL nennt", async () => {
    const ausDerUrl = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    expect(ausDerUrl, "Vorbedingung: DATABASE_URL nennt eine Datenbank").toBeTruthy();

    const ausDerVerbindung = await currentDatabaseName();
    expect(ausDerVerbindung).toBe(ausDerUrl);
  });

  it("dbHostOf liest denselben Host, den das Gate vergleicht", () => {
    const host = dbHostOf(process.env.DATABASE_URL!);
    expect(host).toBe(new URL(process.env.DATABASE_URL!).hostname.toLowerCase());
  });
});
