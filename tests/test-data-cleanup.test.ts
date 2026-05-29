// ---------------------------------------------------------------------------
// Test-Data-Cleanup-Service-Tests (Task #801)
//
// Verifiziert den High-Level-Runner `runTestDataCleanup()` (Single Source of
// Truth für den periodischen Safety-Scheduler aus Task #795):
//  1. Gesäte Test-Pattern-Kunden/-Interessenten/-User werden entfernt, die
//     gelieferten `TestDataCleanupSummary`-Zähler stimmen mit dem tatsächlich
//     gelöschten Bestand überein, und ein zweiter Lauf ist ein idempotenter
//     No-op.
//  2. In `NODE_ENV=production` ist der Runner ein No-op
//     (`{ skipped: true, reason: "production" }`).
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers, prospects } from "../shared/schema";
import { users } from "../shared/schema/users";
import {
  runTestDataCleanup,
  findTestCustomerIds,
  findTestUserIds,
  PROSPECT_TEST_FILTER,
} from "../server/services/test-data-cleanup";

const tag = `cleanup801-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// IDs der von diesem Test gesäten Datensätze (für Notfall-Cleanup im afterAll).
const seededCustomerIds: number[] = [];
const seededProspectIds: number[] = [];
const seededUserIds: number[] = [];

// Snapshots der aktuell vorhandenen Test-Pattern-IDs. Wir vergleichen ZWEI
// Snapshots per Set-Differenz (verschwundene IDs) statt Längen-Deltas: So ist
// die "Zähler == tatsächlich entfernt"-Invariante immun gegen NEBENLÄUFIGE
// INSERTS. (In CI läuft `vitest run` einmalig, integration sequenziell — dort
// ohnehin deterministisch; in dieser Validierungsumgebung läuft parallel noch
// der `test`-Workflow, der ständig Test-Datensätze anlegt → ein reines
// before.length - after.length wäre dadurch off-by-N.)
async function testCustomerIdSet(): Promise<Set<number>> {
  return new Set(await findTestCustomerIds());
}

async function testProspectIdSet(): Promise<Set<number>> {
  const rows = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(PROSPECT_TEST_FILTER);
  return new Set(rows.map((r) => r.id));
}

async function testUserIdSet(): Promise<Set<number>> {
  return new Set(await findTestUserIds());
}

// Anzahl der IDs, die im "before"-Snapshot vorhanden waren und im "after"-
// Snapshot fehlen — also tatsächlich während des Laufs entfernt wurden.
// Nebenläufig NEU angelegte IDs (nur in `after`) bleiben unberücksichtigt.
function countDisappeared(before: Set<number>, after: Set<number>): number {
  let n = 0;
  for (const id of before) if (!after.has(id)) n++;
  return n;
}

beforeAll(async () => {
  // Sicherstellen, dass der Runner NICHT in den Production-No-op läuft.
  process.env.NODE_ENV = "test";

  // 3 Test-Pattern-Kunden (vorname/nachname enthalten "test" → CUSTOMER_TEST_FILTER).
  for (let i = 0; i < 3; i++) {
    const [row] = await db
      .insert(customers)
      .values({
        name: `Test Cleanup ${tag} ${i}`,
        address: "Teststraße 1, 12345 Teststadt",
        vorname: `Test-${tag}`,
        nachname: `Test-${tag}-${i}`,
      })
      .returning({ id: customers.id });
    seededCustomerIds.push(row.id);
  }

  // 2 Test-Pattern-Interessenten (vorname/nachname enthalten "test").
  for (let i = 0; i < 2; i++) {
    const [row] = await db
      .insert(prospects)
      .values({
        vorname: `Test-${tag}`,
        nachname: `Test-${tag}-${i}`,
      })
      .returning({ id: prospects.id });
    seededProspectIds.push(row.id);
  }

  // 2 Test-Pattern-User (E-Mail endet auf @test.local → USER_TEST_FILTER).
  for (let i = 0; i < 2; i++) {
    const [row] = await db
      .insert(users)
      .values({
        email: `testemp-${tag}-${i}@test.local`,
        passwordHash: "x".repeat(60),
        displayName: `Test Cleanup User ${tag} ${i}`,
      })
      .returning({ id: users.id });
    seededUserIds.push(row.id);
  }
});

afterAll(async () => {
  // Notfall-Cleanup, falls der Runner (z.B. wegen Verflechtung) nicht alles
  // gelöscht hat. Best effort.
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

describe("Task #801: runTestDataCleanup()", () => {
  // Großzügiges Timeout: der User-Purge nimmt kurz einen ACCESS-EXCLUSIVE-Lock
  // auf audit_log (DISABLE/ENABLE RULE) und führt viele FK-Detach-Updates aus.
  it("entfernt gesäte Test-Daten, Zähler stimmen mit dem gelöschten Bestand überein und ein zweiter Lauf ist ein No-op", async () => {
    // ID-Snapshot VOR dem Lauf (inkl. evtl. weiterer Stale-Test-Records).
    const custBefore = await testCustomerIdSet();
    const prospBefore = await testProspectIdSet();
    const userBefore = await testUserIdSet();

    // Unsere Saat ist im Bestand enthalten.
    for (const id of seededCustomerIds) expect(custBefore.has(id)).toBe(true);
    for (const id of seededProspectIds) expect(prospBefore.has(id)).toBe(true);
    for (const id of seededUserIds) expect(userBefore.has(id)).toBe(true);

    const summary = await runTestDataCleanup();

    expect(summary.skipped).toBe(false);
    expect(summary.reason).toBeUndefined();

    // ID-Snapshot NACH dem Lauf.
    const custAfter = await testCustomerIdSet();
    const prospAfter = await testProspectIdSet();
    const userAfter = await testUserIdSet();

    // Die gemeldeten Zähler entsprechen exakt dem tatsächlich entfernten Bestand
    // (verschwundene IDs = before \ after; nebenläufige Inserts zählen nicht).
    expect(summary.customersDeleted).toBe(countDisappeared(custBefore, custAfter));
    expect(summary.prospectsDeleted).toBe(countDisappeared(prospBefore, prospAfter));
    expect(summary.usersDeleted).toBe(countDisappeared(userBefore, userAfter));

    // Unsere einfachen, nicht verflochtenen Saat-Records sind alle weg.
    const remainingCust = await db
      .select({ id: customers.id })
      .from(customers)
      .where(inArray(customers.id, seededCustomerIds));
    const remainingProsp = await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(inArray(prospects.id, seededProspectIds));
    const remainingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, seededUserIds));
    expect(remainingCust).toHaveLength(0);
    expect(remainingProsp).toHaveLength(0);
    expect(remainingUsers).toHaveLength(0);

    // Zweiter Lauf: idempotent. Unsere Saat ist bereits weg, ein erneuter Lauf
    // löscht sie NICHT erneut. Wir prüfen dieselbe Set-Differenz-Invariante
    // („gemeldete Zähler == tatsächlich verschwundene IDs") plus: unsere Saat
    // bleibt weg. (Kein globales "== 0", da parallel weiterhin Test-Bestand
    // entstehen kann.)
    const custBefore2 = await testCustomerIdSet();
    const prospBefore2 = await testProspectIdSet();
    const userBefore2 = await testUserIdSet();

    const second = await runTestDataCleanup();
    expect(second.skipped).toBe(false);

    const custAfter2 = await testCustomerIdSet();
    const prospAfter2 = await testProspectIdSet();
    const userAfter2 = await testUserIdSet();

    expect(second.customersDeleted).toBe(countDisappeared(custBefore2, custAfter2));
    expect(second.prospectsDeleted).toBe(countDisappeared(prospBefore2, prospAfter2));
    expect(second.usersDeleted).toBe(countDisappeared(userBefore2, userAfter2));

    // Unsere Saat wurde durch den zweiten Lauf nicht „wiederbelebt"/erneut
    // gezählt — sie ist und bleibt entfernt.
    const stillGoneCust = await db
      .select({ id: customers.id })
      .from(customers)
      .where(inArray(customers.id, seededCustomerIds));
    const stillGoneProsp = await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(inArray(prospects.id, seededProspectIds));
    const stillGoneUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, seededUserIds));
    expect(stillGoneCust).toHaveLength(0);
    expect(stillGoneProsp).toHaveLength(0);
    expect(stillGoneUsers).toHaveLength(0);
  }, 120000);

  it("ist in NODE_ENV=production ein No-op ({ skipped: true, reason: 'production' })", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const summary = await runTestDataCleanup();
      expect(summary.skipped).toBe(true);
      expect(summary.reason).toBe("production");
      expect(summary.customersDeleted).toBe(0);
      expect(summary.prospectsDeleted).toBe(0);
      expect(summary.usersDeleted).toBe(0);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
