// ---------------------------------------------------------------------------
// Sweep-Dev-Test-Data DRY-RUN-Integration (Task #1433)
//
// Task #1430 hat den gescopten CLI-Wrapper
// `server/scripts/sweep-dev-test-data.ts` (npm `db:sweep-dev`) eingeführt.
//
// Die reine, DB-freie CLI-Guard-Logik (`dbHostOf`, `PROD_HOST_PATTERN`,
// `assertDevDatabase` mit den vier Abbruch-Bedingungen) wird seit Task #1439 vom
// DB-freien, IMMER laufenden Unit-Test `tests/architecture/sweep-dev-guard.test.ts`
// abgedeckt (eigenes `static-analysis`-CI-Gate). Dieser Test deckt nur noch den
// DB-GEBUNDENEN Teil ab: der DRY-RUN-Pfad (`runSweep(false)`) führt KEINE
// Löschungen aus.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers, prospects } from "../shared/schema";
import { users } from "../shared/schema/users";
import { runSweep } from "../server/scripts/sweep-dev-test-data";

// runSweep() liest NODE_ENV, DATABASE_URL und PROD_DATABASE_URL zur Aufrufzeit
// (via assertDevDatabase). Wir zwingen den Guard pro Test auf einen sicheren
// Dev-Host und stellen danach den Originalzustand wieder her (auch der parallel
// laufende App-Server in dieser Validierungsumgebung darf nicht beeinflusst
// werden — die Guards parsen die Strings nur, der DB-Pool bleibt an die echte
// Test-DB gebunden).
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
