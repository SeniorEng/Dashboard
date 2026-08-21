// ---------------------------------------------------------------------------
// Sweep-Dev-Test-Data CLI-Prod-Guard-Tests (DB-frei, IMMER laufendes CI-Gate)
//
// Task #1436 hat den Black-Box-Guard-Test der ZERSTÖRERISCHEN Dev-DB-Skripte
// (backup/reseed) als eigenes, IMMER laufendes Gate im `static-analysis`-Job
// verankert. Der schwesterliche Guard für das ebenso zerstörerische
// Sweep-Skript (`server/scripts/sweep-dev-test-data.ts`, npm `db:sweep-dev`)
// hatte dieselbe Lücke: `tests/test-data-cleanup-sweep-guard.test.ts` importiert
// über das Sweep-Skript transitiv `server/lib/db` und liegt deshalb im
// DB-/Server-gegateten `integration`-Vitest-Project — in Forks ohne
// `TEST_USER_*`-Secrets wird es übersprungen, eine Regression der Sweep-Prod-
// Guards bliebe unbemerkt.
//
// Dieser Test deckt die reine CLI-Guard-Logik DB-frei ab: er importiert NUR aus
// dem herausgelösten `server/lib/dev-db-guard` (kein `../lib/db`-Import) und übt:
//  1. `dbHostOf()` — Host-Extraktion aus validen URLs UND aus
//     postgres://…@host:port/db ohne valides URL-Schema (Fallback-Regex).
//  2. `PROD_HOST_PATTERN` — Prod- vs. Dev-Host-Erkennung.
//  3. `assertDevDatabase()` — die vier Abbruch-Bedingungen + Pass-Fälle.
//
// Die DB-gebundene DRY-RUN-Verifikation (`runSweep(false)` ändert nichts) bleibt
// im integration-Test `tests/test-data-cleanup-sweep-guard.test.ts`.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  dbHostOf,
  assertDevDatabase,
  PROD_HOST_PATTERN,
} from "../../server/lib/dev-db-guard";

// assertDevDatabase() liest NODE_ENV, DATABASE_URL und PROD_DATABASE_URL zur
// Aufrufzeit. Wir manipulieren sie pro Test und stellen danach den
// Originalzustand wieder her (auch ein parallel laufender App-Server in der
// Validierungsumgebung darf nicht beeinflusst werden — die Guards parsen die
// Strings nur, keine offene Connection ist betroffen).
let savedEnv: { NODE_ENV?: string; DATABASE_URL?: string; PROD_DATABASE_URL?: string };

beforeEach(() => {
  savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    PROD_DATABASE_URL: process.env.PROD_DATABASE_URL,
  };
});

afterEach(() => {
  for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("sweep-dev-test-data dbHostOf()", () => {
  it("extrahiert den Hostnamen aus einer validen postgres-URL", () => {
    expect(dbHostOf("postgresql://user:pass@db.dev.example:5432/app")).toBe("db.dev.example");
  });

  it("lowercased den Hostnamen", () => {
    expect(dbHostOf("postgresql://user:pass@DB.PROD.Example:5432/app")).toBe("db.prod.example");
  });

  it("liefert bei malformtem Schema (Leerzeichen) einen leeren Host (fail-closed)", () => {
    // `new URL(...)` wirft hier (kaputtes Schema mit Leerzeichen). Der Fallback
    // akzeptiert NUR ein gültiges `scheme://`-Präfix — zeichengleich zur sed-Regex
    // in scripts/lib/assert-dev-db.sh (Cross-Language-Parität, Task #1438). Ein
    // malformtes Schema liefert daher KEINEN Host, sondern leer → der Aufrufer
    // bricht fail-closed ab (Prod-Schutz). Eine reine `@host`-Regex würde hier
    // fälschlich `legacy-dev-host` extrahieren und die Guards passieren lassen.
    expect(dbHostOf("postgres ://x@legacy-dev-host:5432/app")).toBe("");
  });

  it("liefert leeren String, wenn kein Host ermittelbar ist", () => {
    expect(dbHostOf("not-a-url-at-all")).toBe("");
    expect(dbHostOf("")).toBe("");
  });
});

describe("sweep-dev-test-data PROD_HOST_PATTERN", () => {
  it.each([
    "db.prod.example",
    "db.production.internal",
    "prod-db.example",
    "db-prod.example",
    "myproductiondb.example",
  ])("matched Prod-Host '%s'", (host) => {
    expect(PROD_HOST_PATTERN.test(host)).toBe(true);
  });

  it.each([
    "db.dev.example",
    "localhost",
    "staging-db.example",
    "ep-cool-name-123.eu-central-1.aws.neon.tech",
  ])("matched Dev-Host '%s' NICHT", (host) => {
    expect(PROD_HOST_PATTERN.test(host)).toBe(false);
  });
});

describe("sweep-dev-test-data assertDevDatabase() Guards", () => {
  it("bricht bei NODE_ENV=production ab", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@db.dev.example:5432/app";
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).toThrow(/NODE_ENV=production/);
  });

  it("bricht ab, wenn DATABASE_URL nicht gesetzt ist", () => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).toThrow(/DATABASE_URL ist nicht gesetzt/);
  });

  it("bricht bei einem Prod-aussehenden DB-Host ab", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@db.prod.example:5432/app";
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).toThrow(/sieht nach Produktion aus/);
  });

  it("bricht bei einem 'production'-Host ab", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@careconnect-production.example:5432/app";
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).toThrow(/sieht nach Produktion aus/);
  });

  it("fail-closed: bricht ab, wenn der Host nicht extrahierbar ist", () => {
    process.env.NODE_ENV = "test";
    // Weder valide URL noch @host-Match → leerer Host → fail-closed.
    process.env.DATABASE_URL = "garbage-without-host";
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).toThrow(/fail-closed/);
  });

  it("bricht ab, wenn DATABASE_URL == PROD_DATABASE_URL (Host UND Datenbank)", () => {
    // Verschaerft: frueher genuegte Host-Gleichheit. Auf Replit heisst der
    // interne Host in Dev und Prod gleich — Host allein sagt also nichts
    // ueber die tatsaechliche Datenbank. Jetzt zaehlen beide.
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@shared-host.example:5432/neondb";
    process.env.PROD_DATABASE_URL = "postgresql://other:secret@shared-host.example:5432/neondb";
    expect(() => assertDevDatabase()).toThrow(/DATABASE_URL == PROD_DATABASE_URL/);
  });

  it("gleicher Host, ANDERE Datenbank ist erlaubt", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@shared-host.example:5432/careconnect_dev";
    process.env.PROD_DATABASE_URL = "postgresql://other:secret@shared-host.example:5432/neondb";
    expect(() => assertDevDatabase()).not.toThrow();
  });


  it("passiert bei einem normalen Dev-Host (auch wenn PROD_DATABASE_URL auf einen anderen Host zeigt)", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@db.dev.example:5432/app";
    process.env.PROD_DATABASE_URL = "postgresql://other:secret@db.prod.example:5432/app";
    expect(() => assertDevDatabase()).not.toThrow();
  });

  it("passiert ohne gesetztes PROD_DATABASE_URL", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@db.dev.example:5432/app";
    delete process.env.PROD_DATABASE_URL;
    expect(() => assertDevDatabase()).not.toThrow();
  });
});
