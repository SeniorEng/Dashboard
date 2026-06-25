// ---------------------------------------------------------------------------
// Sweep-Dev-Test-Data CLI-Guard-Tests (Task #1433)
//
// Task #1430 hat den gescopten CLI-Wrapper
// `server/scripts/sweep-dev-test-data.ts` (npm `db:sweep-dev`) eingeführt. Seine
// Schutz-Schicht (NODE_ENV=production, Prod-Host-Pattern, fail-closed bei nicht
// ermittelbarem Host, DATABASE_URL-Host == PROD_DATABASE_URL-Host) wurde bisher
// nur manuell ausgeübt — eine Regression könnte den Sweep auf eine Nicht-Dev-DB
// richten. `tests/test-data-cleanup.test.ts` deckt den darunterliegenden Runner
// `runTestDataCleanup()` ab, NICHT diese CLI-Guard-Schicht.
//
// Dieser Test übt:
//  1. `dbHostOf()` — Host-Extraktion aus validen URLs UND aus
//     postgres://…@host:port/db ohne valides URL-Schema (Fallback-Regex).
//  2. `assertDevDatabase()` — die vier Abbruch-Bedingungen + ein normaler
//     Dev-Host passiert.
//  3. Der DRY-RUN-Pfad (`runSweep(false)`) führt KEINE Löschungen aus.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers, prospects } from "../shared/schema";
import { users } from "../shared/schema/users";
import {
  dbHostOf,
  assertDevDatabase,
  runSweep,
  PROD_HOST_PATTERN,
} from "../server/scripts/sweep-dev-test-data";

// Env-Snapshot: assertDevDatabase()/runSweep() lesen NODE_ENV, DATABASE_URL und
// PROD_DATABASE_URL zur Aufrufzeit. Wir manipulieren sie pro Test und stellen
// danach den Originalzustand wieder her (auch der parallel laufende App-Server in
// dieser Validierungsumgebung darf nicht beeinflusst werden — die Guards parsen
// die Strings nur, der DB-Pool bleibt an die echte Test-DB gebunden).
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

describe("Task #1433: sweep-dev-test-data dbHostOf()", () => {
  it("extrahiert den Hostnamen aus einer validen postgres-URL", () => {
    expect(dbHostOf("postgresql://user:pass@db.dev.example:5432/app")).toBe("db.dev.example");
  });

  it("lowercased den Hostnamen", () => {
    expect(dbHostOf("postgresql://user:pass@DB.PROD.Example:5432/app")).toBe("db.prod.example");
  });

  it("fällt bei nicht-parsebarer URL auf die @host-Regex zurück", () => {
    // `new URL(...)` wirft hier (kaputtes Schema) → Fallback-Regex `@([^:/?#]+)`
    // greift und liest den Host hinter dem `@`.
    expect(dbHostOf("postgres ://x@legacy-dev-host:5432/app")).toBe("legacy-dev-host");
  });

  it("liefert leeren String, wenn kein Host ermittelbar ist", () => {
    expect(dbHostOf("not-a-url-at-all")).toBe("");
    expect(dbHostOf("")).toBe("");
  });
});

describe("Task #1433: PROD_HOST_PATTERN", () => {
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

describe("Task #1433: assertDevDatabase() Guards", () => {
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

  it("bricht ab, wenn DATABASE_URL-Host == PROD_DATABASE_URL-Host", () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@shared-host.example:5432/dev";
    process.env.PROD_DATABASE_URL = "postgresql://other:secret@shared-host.example:5432/prod";
    expect(() => assertDevDatabase()).toThrow(/DATABASE_URL-Host == PROD_DATABASE_URL-Host/);
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

describe("Task #1433: runSweep() DRY-RUN führt keine Löschungen aus", () => {
  const tag = `sweep1433-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const seededCustomerIds: number[] = [];
  const seededProspectIds: number[] = [];
  const seededUserIds: number[] = [];

  beforeAll(async () => {
    // 2 Test-Pattern-Kunden (vorname/nachname enthalten "test" → CUSTOMER_TEST_FILTER).
    for (let i = 0; i < 2; i++) {
      const [row] = await db
        .insert(customers)
        .values({
          name: `Test Sweep ${tag} ${i}`,
          address: "Teststraße 1, 12345 Teststadt",
          vorname: `Test-${tag}`,
          nachname: `Test-${tag}-${i}`,
        })
        .returning({ id: customers.id });
      seededCustomerIds.push(row.id);
    }
    // 2 Test-Pattern-Interessenten.
    for (let i = 0; i < 2; i++) {
      const [row] = await db
        .insert(prospects)
        .values({ vorname: `Test-${tag}`, nachname: `Test-${tag}-${i}` })
        .returning({ id: prospects.id });
      seededProspectIds.push(row.id);
    }
    // 2 Test-Pattern-User (@test.local → USER_TEST_FILTER).
    for (let i = 0; i < 2; i++) {
      const [row] = await db
        .insert(users)
        .values({
          email: `testsweep-${tag}-${i}@test.local`,
          passwordHash: "x".repeat(60),
          displayName: `Test Sweep User ${tag} ${i}`,
        })
        .returning({ id: users.id });
      seededUserIds.push(row.id);
    }
  });

  afterAll(async () => {
    // Aufräumen (best effort) — der DRY-RUN löscht nichts, also tun wir es hier.
    try {
      if (seededCustomerIds.length > 0) {
        await db.delete(customers).where(inArray(customers.id, seededCustomerIds));
      }
    } catch {}
    try {
      if (seededProspectIds.length > 0) {
        await db.delete(prospects).where(inArray(prospects.id, seededProspectIds));
      }
    } catch {}
    try {
      if (seededUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, seededUserIds));
      }
    } catch {}
  });

  it("zählt nur und lässt die gesäten Test-Daten unangetastet", async () => {
    // Guard auf einen sicheren Dev-Host zwingen, damit assertDevDatabase()
    // unabhängig vom konkreten Ephemeral-DB-Host deterministisch passiert. Der
    // bereits geöffnete DB-Pool bleibt an die echte Test-DB gebunden (das Env
    // beeinflusst nur die String-basierten Guards, nicht die offene Connection).
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://user:pass@db.dev.example:5432/app";
    delete process.env.PROD_DATABASE_URL;

    await expect(runSweep(false)).resolves.toBeUndefined();

    // Nichts wurde gelöscht.
    const cust = await db
      .select({ id: customers.id })
      .from(customers)
      .where(inArray(customers.id, seededCustomerIds));
    const prosp = await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(inArray(prospects.id, seededProspectIds));
    const usr = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, seededUserIds));
    expect(cust).toHaveLength(seededCustomerIds.length);
    expect(prosp).toHaveLength(seededProspectIds.length);
    expect(usr).toHaveLength(seededUserIds.length);
  });
});
