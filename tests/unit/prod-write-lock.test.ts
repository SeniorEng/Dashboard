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
