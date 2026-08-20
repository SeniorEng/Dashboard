/**
 * Laufzeit-Schreibsperre — die acht Fälle, an denen sie sich messen lassen muss.
 *
 * ── Warum es sie gibt ───────────────────────────────────────────────────
 * Der statische Wächter (`prod-write-gate-coverage`) liest Quelltext und sieht
 * deshalb nur den direkten Weg. Gemessen am 20.08.2026: 15 Skripte schreiben
 * sichtbar, **12 unsichtbar** über importierte Storage-/Service-Helfer — zwei
 * davon erzeugen Stornorechnungen. Diese Sperre sitzt am Treiber, wo jeder Weg
 * zusammenläuft.
 *
 * ── Warum echte Kontext-Wechsel und keine Mocks ─────────────────────────
 * Die Klassifikation liest `process.argv[1]` und die Test-Env. Würde sie hier
 * gemockt, prüften die Tests genau die Annahme, die sie belegen sollen — der
 * Fehler, der in `prod-write-gate.test.ts` schon einmal im Kommentar stand.
 * Deshalb wird der Prozess-Zustand echt umgestellt und danach zurückgesetzt.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  devZielGeprueft,
  ermittleKontext,
  freigabeErteilen,
  freigabeZuruecksetzen,
  mitSchreibsperre,
} from "../../server/lib/prod-write-lock";
import {
  assertEphemeralTestDbIfConfigured,
  evaluateTestDbTarget,
} from "../../scripts/lib/ephemeral-db-guard";

const ORIGINAL_ARGV1 = process.argv[1];
const ORIGINAL_ENV = { ...process.env };

/** Versetzt den Prozess echt in Skript-Kontext (kein Mock). */
function alsSkript(pfad = "/repo/server/scripts/irgendein-fix.ts"): void {
  process.argv[1] = pfad;
  delete process.env.VITEST;
  delete process.env.VITEST_WORKER_ID;
  delete process.env.NODE_ENV;
  // Skript-Kontext ALLEIN genuegt nicht mehr: seit CI gezeigt hat, dass die
  // Seeds legitim schreiben, gilt eine verifizierte Wegwerf-DB als zweite
  // gueltige Zieldeklaration. Fuer „Ziel ungeprueft" muessen diese drei weg.
  delete process.env.CI;
  delete process.env.TEST_DATABASE_URLS;
  delete process.env.DATABASE_URL;
}

function alsApp(): void {
  process.argv[1] = "/app/dist/index.cjs";
  delete process.env.VITEST;
  delete process.env.VITEST_WORKER_ID;
  delete process.env.NODE_ENV;
}

beforeEach(() => {
  freigabeZuruecksetzen();
});

afterEach(() => {
  process.argv[1] = ORIGINAL_ARGV1;
  process.env = { ...ORIGINAL_ENV };
  freigabeZuruecksetzen();
});

/** Minimales db-Doppel: die Sperre arbeitet auf jedem Objekt mit dieser Form. */
function fakeDb() {
  const gerufen: string[] = [];
  const basis = {
    gerufen,
    insert: (..._a: unknown[]) => {
      gerufen.push("insert");
      return "ok";
    },
    update: (..._a: unknown[]) => {
      gerufen.push("update");
      return "ok";
    },
    delete: (..._a: unknown[]) => {
      gerufen.push("delete");
      return "ok";
    },
    select: (..._a: unknown[]) => {
      gerufen.push("select");
      return "ok";
    },
    execute: (_sql: unknown) => {
      gerufen.push("execute");
      return "ok";
    },
    transaction: async (cb: (tx: unknown) => unknown) => {
      // Wie drizzle: das tx-Objekt hat dieselbe Schreibfläche.
      const tx = {
        insert: (..._a: unknown[]) => {
          gerufen.push("tx.insert");
          return "ok";
        },
        update: (..._a: unknown[]) => {
          gerufen.push("tx.update");
          return "ok";
        },
        delete: (..._a: unknown[]) => {
          gerufen.push("tx.delete");
          return "ok";
        },
        execute: (_sql: unknown) => {
          gerufen.push("tx.execute");
          return "ok";
        },
      };
      return cb(tx);
    },
  };
  return basis;
}

describe("Schreibsperre — Kontext-Diskriminierung", () => {
  it("5) App-Write geht durch — die laufende Anwendung wird NICHT angefasst", () => {
    // Requests haben ihre eigene Authz. Hier zu prüfen hiesse, die App zu
    // brechen — der teuerste denkbare Fehlschlag dieser Sperre.
    alsApp();
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.update()).not.toThrow();
    expect(() => db.insert()).not.toThrow();
    expect(db.gerufen).toEqual(["update", "insert"]);
  });

  it("6) unklarer Entrypoint wirft — fail-closed, nicht fail-open", () => {
    // `tsx -e`, umbenanntes Skript, fremder Wrapper: ein Zweifelsfall darf
    // nicht in den Freifahrtschein fallen.
    for (const argv1 of [undefined, "/repo/node_modules/.bin/tsx", "/tmp/irgendwas.js"]) {
      expect(ermittleKontext(argv1, {} as NodeJS.ProcessEnv)).toBe("skript");
    }
    alsSkript("/tmp/irgendwas.js");
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.update()).toThrow(/ohne Ziel-Freigabe/);
  });

  it("erkennt die App an beiden Entrypoint-Formen", () => {
    const leer = {} as NodeJS.ProcessEnv;
    expect(ermittleKontext("/app/dist/index.cjs", leer)).toBe("app");
    // `npm run dev` faehrt `tsx server/index.ts`; gemessen setzt tsx argv[1]
    // auf den Skriptpfad, nicht auf die eigene Binary.
    expect(ermittleKontext("/repo/server/index.ts", leer)).toBe("app");
  });
});

describe("Schreibsperre — Skript-Kontext", () => {
  it("1) Skript-Write ohne Assert wirft", () => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.insert()).toThrow(/ohne Ziel-Freigabe/);
    expect(() => db.update()).toThrow(/Blockierte Operation: update/);
    expect(() => db.delete()).toThrow(/Blockierte Operation: delete/);
  });

  it("2) Write ueber tx ohne Assert wirft — der Indirektions-Kernfall", async () => {
    // Genau hierueber schreiben die Storage-Helfer
    // (`rebookAppointmentConsumption`, `stornoInvoiceDocumentOnly`). Wuerde nur
    // `db` umhuellt und nicht das an den Callback gereichte `tx`, fiele die
    // ganze Klasse durch, fuer die diese Sperre gebaut wurde.
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    await expect(
      db.transaction(async (tx) => (tx as { update: () => unknown }).update()),
    ).rejects.toThrow(/ohne Ziel-Freigabe/);
  });

  it("3) lesendes execute geht durch — sonst blockiert sie Report-Skripte", () => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.execute("SELECT status, count(*) FROM invoices GROUP BY 1")).not.toThrow();
    // Auch ein Kommentar, der wie ein Schreibbefehl aussieht, darf nicht sperren.
    expect(() => db.execute("SELECT 1 -- DELETE FROM invoices")).not.toThrow();
  });

  it("4) schreibendes execute ohne Assert wirft", () => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    for (const sql of [
      "UPDATE invoices SET status = 'bezahlt'",
      "INSERT INTO audit_log (action) VALUES ('x')",
      "DELETE FROM budget_allocations WHERE id = 1",
      "TRUNCATE invoices",
      "ALTER TABLE invoices ADD COLUMN x text",
    ]) {
      expect(() => db.execute(sql), sql).toThrow(/ohne Ziel-Freigabe/);
    }
  });

  it("eine unlesbare execute-Form gilt als Schreiben (fail-closed)", () => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    // Was wir nicht lesen koennen, duerfen wir nicht freigeben.
    expect(() => db.execute({ etwas: "fremdes" })).toThrow(/ohne Ziel-Freigabe/);
  });

  it("nach erteilter Freigabe schreibt dasselbe Skript durch — auch ueber tx", async () => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    freigabeErteilen("helium/neondb");
    expect(() => db.update()).not.toThrow();
    expect(() => db.execute("UPDATE invoices SET status = 'bezahlt'")).not.toThrow();
    await expect(
      db.transaction(async (tx) => (tx as { insert: () => unknown }).insert()),
    ).resolves.toBe("ok");
  });
});

describe("Schreibsperre — die Test-Ausnahme und ihr Unterbau", () => {
  it("7) Test-Kontext + nicht-als-Wegwerf-erkannte DB wirft", () => {
    // Die Sperre nimmt Test-Kontext aus. Das traegt NUR, weil der
    // Wegwerf-DB-Guard dort unbedingt greift — sonst waere die Ausnahme ein
    // Prod-Schreib-Loch.
    expect(() =>
      assertEphemeralTestDbIfConfigured({
        DATABASE_URL: "postgres://u:p@helium/neondb",
      } as NodeJS.ProcessEnv),
    ).toThrow(/NICHT-Wegwerf-Datenbank/);
  });

  it("die legitimen Testlaeufe passieren weiterhin", () => {
    // Der Caveat: wer hier zu streng ist, macht gruene Laeufe rot und die
    // Zusage wird abgeschaltet.
    const legitim: [string, NodeJS.ProcessEnv][] = [
      ["CI", { CI: "true" } as NodeJS.ProcessEnv],
      [
        "Orchestrator",
        { TEST_DATABASE_URLS: "postgres://u:p@localhost/cc_test_a_w0" } as NodeJS.ProcessEnv,
      ],
      [
        "lokale Wegwerf-DB",
        {
          DATABASE_URL: "postgres://postgres:postgres@localhost:5432/cc_test_careconnect",
        } as NodeJS.ProcessEnv,
      ],
    ];
    for (const [name, env] of legitim) {
      expect(evaluateTestDbTarget(env).ok, name).toBe(true);
      expect(() => assertEphemeralTestDbIfConfigured(env), name).not.toThrow();
    }
    // Und der Fall, der den Caveat ausgeloest hat: gar keine DB-URL. Die
    // meisten Unit-Tests brauchen keine Datenbank; ein strenges Werfen haette
    // `vitest run --project unit` neu rot gemacht.
    expect(() => assertEphemeralTestDbIfConfigured({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("im Test-Kontext greift die Schreibsperre selbst nicht", () => {
    // Ohne diese Ausnahme muessten ~1780 Tests das Ziel-Gate bedienen.
    expect(ermittleKontext("/repo/server/scripts/x.ts", { VITEST: "true" } as NodeJS.ProcessEnv)).toBe(
      "test",
    );
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.update()).not.toThrow();
  });
});

describe("Die zweite gueltige Zieldeklaration: verifizierte Wegwerf-DB", () => {
  it("Skript-Write auf eine cc_test_-DB geht durch — ohne Prod-Gate", () => {
    // Der Fall, den CI im ersten Anlauf rot gemacht hat:
    // `scripts/ci-seed-superadmin.ts` legt den Test-Superadmin an. Er hat kein
    // Prod-Gate und darf keines haben — er darf nie auf Prod zeigen.
    alsSkript("/repo/scripts/ci-seed-superadmin.ts");
    process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/cc_test_x_w0";
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.insert()).not.toThrow();
    expect(() => db.execute("INSERT INTO users (email) VALUES ('x')")).not.toThrow();
  });

  it("dieselbe Datei auf einer ECHTEN DB wirft weiterhin", () => {
    alsSkript("/repo/scripts/ci-seed-superadmin.ts");
    process.env.DATABASE_URL = "postgres://u:p@helium/neondb";
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.insert()).toThrow(/ohne Ziel-Freigabe/);
  });

  it("Orchestrator-Worker-DBs zaehlen ebenfalls als geprueftes Ziel", () => {
    alsSkript();
    process.env.TEST_DATABASE_URLS = "postgres://u:p@localhost/cc_test_a_w0";
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.update()).not.toThrow();
  });
});

describe("Die Loecher, die der Review aufgedeckt hat", () => {
  it("NODE_ENV=test allein schaltet die Sperre NICHT ab", () => {
    // CLAUDE.md schreibt fuer den lokalen Testbetrieb
    // `set -a; . ./.env.test.local; set +a` vor — und diese Datei setzt
    // NODE_ENV=test. Haette das gereicht, waere die Sperre in genau der Shell
    // tot gewesen, in der hier taeglich gearbeitet wird.
    expect(
      ermittleKontext("/repo/server/scripts/x.ts", { NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBe("skript");
    alsSkript();
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://u:p@helium/neondb";
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.insert()).toThrow(/ohne Ziel-Freigabe/);
  });

  it("nur echtes Vitest gilt als Test-Kontext", () => {
    for (const env of [{ VITEST: "true" }, { VITEST_WORKER_ID: "3" }]) {
      expect(ermittleKontext("/repo/server/scripts/x.ts", env as NodeJS.ProcessEnv)).toBe("test");
    }
  });

  it("der Dev-DB-Nachweis ist eine gueltige Zieldeklaration", () => {
    // Ohne ihn waeren `npm run db:sweep-dev`, `cleanup:test-data`,
    // `purge:junk-master-data` und `budget:correct-km-drift` nicht mehr
    // ausfuehrbar: das Prod-Gate verlangt NODE_ENV=production und lehnt lokale
    // Hosts ab, kann fuer die Dev-DB also per Konstruktion nie greifen. Eine
    // Sperre, die legitime Arbeit unmoeglich macht, wird umgangen.
    alsSkript("/repo/server/scripts/sweep-dev-test-data.ts");
    process.env.DATABASE_URL = "postgres://u:p@dev-host/careconnect_dev";
    const db = mitSchreibsperre(fakeDb());
    expect(() => db.delete()).toThrow(/ohne Ziel-Freigabe/);

    devZielGeprueft("dev/dev-host");
    expect(() => db.delete()).not.toThrow();
  });
});

describe("Die Huelle an einer ECHTEN drizzle-Instanz", () => {
  // Die uebrigen Faelle laufen gegen ein handgeschriebenes Doppel. Die
  // teuerste Frage des PR — geht `select`, `$with`, `$count`, `query` durch,
  // bricht `.bind()` etwas? — beantwortet das nicht. Hier wird sie beantwortet.
  it("Lesepfade und Query-Builder funktionieren durch die Huelle", async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { invoices } = await import("@shared/schema");
    const roh = drizzle({} as never);
    const gesperrt = mitSchreibsperre(roh);

    alsSkript();
    // Ein Query-Builder-Aufruf, der NICHT schreibt, muss unveraendert
    // funktionieren — bis hin zum erzeugten SQL.
    const abfrage = gesperrt.select().from(invoices).toSQL();
    expect(abfrage.sql).toMatch(/select/i);
    expect(abfrage.sql).toMatch(/invoices/i);
    // Relational-API und interne Felder gehen als Objekte durch.
    expect(gesperrt.query).toBeDefined();
    expect(typeof gesperrt.$with).toBe("function");
  });

  it("schreibende Query-Builder-Aufrufe werden auch dort geblockt", async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { invoices } = await import("@shared/schema");
    const gesperrt = mitSchreibsperre(drizzle({} as never));
    alsSkript();
    expect(() => gesperrt.delete(invoices)).toThrow(/ohne Ziel-Freigabe/);
  });
});

describe("execute — die Formen aus dem Gate-2-Review", () => {
  it.each([
    ["SELECT setval('invoice_seq', 5000)", true],
    ["COPY invoices FROM STDIN", true],
    ["CREATE OR REPLACE VIEW v AS SELECT 1", true],
    ["REFRESH MATERIALIZED VIEW mv", true],
    ["DROP SEQUENCE s", true],
    ["ALTER SEQUENCE s RESTART", true],
    ["GRANT SELECT ON invoices TO app", true],
    // Schreibt selbst nichts, hebt aber den GoBD-Mutations-Riegel der
    // DB-Trigger auf — gehoert nicht in die harmlose Klasse.
    ["SET LOCAL app.allow_gobd_mutation = 'on'", true],
    // Zeilensperren sind LESEND. Ein Riegel, der Reports blockiert, wird
    // abgeschaltet.
    ["SELECT * FROM invoices FOR UPDATE SKIP LOCKED", false],
    ["SELECT * FROM invoices FOR UPDATE OF invoices", false],
  ])("%s -> blockiert: %s", (sqlText, blockiert) => {
    alsSkript();
    const db = mitSchreibsperre(fakeDb());
    if (blockiert) expect(() => db.execute(sqlText)).toThrow(/ohne Ziel-Freigabe/);
    else expect(() => db.execute(sqlText)).not.toThrow();
  });
});

describe("8) Gegenprobe: die tx-Huelle ist nicht optional", () => {
  it("ohne Umhuellung des tx wuerde der Indirektionsfall durchrutschen", async () => {
    // Dieser Test zeigt, was Fall 2 misst: derselbe Aufruf auf einem NICHT
    // umhuellten Transaktions-Objekt geht durch. Faellt `transaction` aus
    // `mitSchreibsperre` heraus, wird Fall 2 gruen — und genau das darf nicht
    // unbemerkt passieren.
    alsSkript();
    const roh = fakeDb();
    const ergebnis = await roh.transaction(async (tx) =>
      (tx as { update: () => unknown }).update(),
    );
    expect(ergebnis).toBe("ok");
    expect(roh.gerufen).toContain("tx.update");

    // Mit Huelle: derselbe Weg wirft.
    const gesperrt = mitSchreibsperre(fakeDb());
    await expect(
      gesperrt.transaction(async (tx) => (tx as { update: () => unknown }).update()),
    ).rejects.toThrow(/ohne Ziel-Freigabe/);
  });
});
