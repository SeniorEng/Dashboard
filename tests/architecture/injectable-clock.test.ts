/**
 * §45b-Präventions-Cluster Welle 1 — Wächter für die injizierbare Uhr.
 *
 * Die Uhr ist ein TESTWERKZEUG. Ihr einziger Daseinszweck ist, §45b-Fristen
 * (Verfall 30.06., Halbjahres-Boden, Jahreswechsel) prüfbar zu machen. Damit
 * sie nie zu einem Produktiv-Schalter wird, nagelt dieser Test die drei
 * Zusagen fest, auf denen das Gate-1-Urteil beruht:
 *
 *  1. `setClockProvider` WIRFT außerhalb `NODE_ENV === "test"`.
 *  2. Die `X-Test-Clock`-Middleware wird außerhalb `NODE_ENV === "test"` NICHT
 *     registriert — der Header trifft dort auf keinen Leser.
 *  3. KEIN Produktivcode ruft `setClockProvider` / `useTestClock` / … auf.
 *
 * Failure-Modus: bricht mit der verletzten Zusage. Behebung ist nie „Wächter
 * lockern", sondern den Aufruf aus dem Produktivpfad entfernen.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { resetClockProvider, setClockProvider, todayISO } from "@shared/utils/datetime";

const ROOT = process.cwd();

/** Produktiv-Bäume: hier darf die Uhr nirgends angefasst werden. */
const PRODUKTIV_BAEUME = ["server", "shared", "client", "scripts", "script"];

/**
 * Einzige erlaubte Ausnahmen — die Naht selbst und ihre Mechanik. Beide sind
 * fail-closed und werden von diesem Test mitgeprüft.
 */
const NAHT_DATEIEN = new Set([
  join("shared", "utils", "datetime.ts"),
  join("server", "lib", "test-clock.ts"),
]);

/**
 * `server/index.ts` importiert die Middleware statisch (CJS-Bundle verträgt
 * kein Top-Level-`await`) und registriert sie hinter dem NODE_ENV-Gate. Der
 * Import allein ist folgenlos; Zusage 2 unten prüft die Registrierung.
 */
const REGISTRIERUNGS_DATEI = join("server", "index.ts");

function* walk(dir: string): Generator<string> {
  let eintraege: string[];
  try {
    eintraege = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of eintraege) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

function produktivDateien(): string[] {
  const out: string[] = [];
  for (const baum of PRODUKTIV_BAEUME) {
    for (const datei of walk(join(ROOT, baum))) {
      const rel = relative(ROOT, datei);
      if (rel.split(sep).includes("__tests__")) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

describe("Injizierbare Uhr — Zusage 1: Setter ist fail-closed", () => {
  const vorher = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = vorher;
    resetClockProvider();
  });

  for (const env of ["production", "development", "staging", undefined]) {
    it(`wirft bei NODE_ENV=${env ?? "undefined"}`, () => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;

      expect(() => setClockProvider(() => new Date(2027, 6, 1))).toThrow(/nur unter NODE_ENV=test/);
    });
  }

  it("setzt unter NODE_ENV=test und wirkt auf todayISO()", () => {
    process.env.NODE_ENV = "test";
    setClockProvider(() => new Date(2027, 6, 1, 12));
    expect(todayISO()).toBe("2027-07-01");
  });

  it("resetClockProvider stellt die Echt-Uhr wieder her — ohne Env-Guard", () => {
    process.env.NODE_ENV = "test";
    setClockProvider(() => new Date(2027, 6, 1, 12));
    expect(todayISO()).toBe("2027-07-01");

    // Der Weg ZURÜCK muss immer offenstehen, auch wenn das Env inzwischen
    // nicht mehr "test" ist (Sicherheitsnetz in tests/setup.ts).
    process.env.NODE_ENV = "production";
    expect(() => resetClockProvider()).not.toThrow();
    expect(todayISO()).not.toBe("2027-07-01");
  });
});

describe("Injizierbare Uhr — Zusage 2: Middleware nur unter NODE_ENV=test", () => {
  it("registriert `testClockMiddleware` ausschließlich hinter dem NODE_ENV-Gate", () => {
    const quelle = readFileSync(join(ROOT, REGISTRIERUNGS_DATEI), "utf8");
    const zeilen = quelle.split("\n");
    const nutzung = zeilen.findIndex(z => /app\.use\(\s*testClockMiddleware/.test(z));

    expect(
      nutzung,
      "`testClockMiddleware` wird in server/index.ts nicht mehr registriert — " +
        "dann ist die Uhr über HTTP wirkungslos und die §45b-Fristentests messen nichts.",
    ).toBeGreaterThan(-1);

    // Direkt darüber MUSS das Gate stehen. Wir prüfen die drei Zeilen davor,
    // damit eine Leerzeile oder ein Kommentar dazwischen nicht falsch-rot wird.
    const davor = zeilen.slice(Math.max(0, nutzung - 3), nutzung).join("\n");
    expect(
      davor,
      "`app.use(testClockMiddleware)` steht nicht mehr hinter `NODE_ENV === \"test\"`. " +
        "Damit läse auch Produktion den X-Test-Clock-Header — die Uhr wäre ein Produktiv-Schalter.",
    ).toMatch(/process\.env\.NODE_ENV\s*===\s*["']test["']/);
  });
});

describe("Injizierbare Uhr — Zusage 3: kein Produktivcode setzt die Uhr", () => {
  const VERBOTEN = /\b(setClockProvider|setProcessTestClock|runWithClock|useTestClock)\s*\(/;

  it("findet keinen Setter-Aufruf außerhalb der Naht", () => {
    const treffer: string[] = [];
    for (const rel of produktivDateien()) {
      if (NAHT_DATEIEN.has(rel)) continue;
      const inhalt = readFileSync(join(ROOT, rel), "utf8");
      if (VERBOTEN.test(inhalt)) treffer.push(rel);
    }

    expect(
      treffer,
      "Produktivcode darf die Uhr nicht setzen. Die injizierbare Uhr ist ein " +
        "Testwerkzeug; ein Produktiv-Aufruf würde die Systemzeit verbiegen. " +
        `Gefunden in: ${treffer.join(", ")}`,
    ).toEqual([]);
  });

  it("importiert `node:async_hooks` nicht in `shared/` (Client-Bundle)", () => {
    const treffer = produktivDateien()
      .filter(rel => rel.startsWith(`shared${sep}`))
      .filter(rel => /from\s+["']node:/.test(readFileSync(join(ROOT, rel), "utf8")));

    expect(
      treffer,
      "`shared/` wird auch in den Browser gebündelt und darf keinen `node:`-Import " +
        `tragen. Die ALS-Mechanik gehört nach server/lib/test-clock.ts. Gefunden in: ${treffer.join(", ")}`,
    ).toEqual([]);
  });
});
