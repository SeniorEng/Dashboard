/**
 * Task #1262 — Einmaliger Prod-Startup-Cleanup unbenutzter Pflegekassen.
 *
 * Prüft den env-agnostischen Kern `applyUnusedInsuranceCleanupMigration`:
 *   - eine UNBENUTZTE Kasse (keine Kundenzuordnung) wird gelöscht,
 *   - eine REFERENZIERTE Kasse (mit `customer_insurance_history`) bleibt,
 *   - es entsteht ein Ledger- UND ein Audit-Eintrag,
 *   - der Lauf ist exactly-once (zweiter Aufruf → `skipped`, keine Mutation).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, insuranceProviders, customerInsuranceHistory, auditLog } from "@shared/schema";
import { uniqueId } from "../test-utils";
import {
  applyUnusedInsuranceCleanupMigration,
  CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME,
} from "../../server/startup/cleanup-unused-insurance-providers";

const TAG = `t1262-${uniqueId()}`;

let referencedProviderId: number;
let unusedProviderId: number;
let customerId: number;
let snapshotRows: (typeof insuranceProviders.$inferSelect)[] = [];

beforeAll(async () => {
  // Sauberer Erstlauf: evtl. vorhandenen Ledger-Eintrag entfernen
  // (`budget_migrations` hat KEINEN Immutability-Trigger — operative Metadaten).
  await db.execute(
    sql`DELETE FROM budget_migrations WHERE name = ${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME}`,
  );

  const [ref] = await db
    .insert(insuranceProviders)
    .values({ name: `Referenziert-${TAG}`, isPrivate: false } as any)
    .returning({ id: insuranceProviders.id });
  referencedProviderId = ref.id;

  const [unused] = await db
    .insert(insuranceProviders)
    .values({ name: `Unbenutzt-${TAG}`, isPrivate: true } as any)
    .returning({ id: insuranceProviders.id });
  unusedProviderId = unused.id;

  const [cust] = await db
    .insert(customers)
    .values({
      name: `T1262-Kunde-${TAG}`,
      address: "Teststraße 1, 10115 Berlin",
      vorname: "T1262",
      nachname: `Kunde-${TAG}`,
      billingType: "selbstzahler",
    } as any)
    .returning({ id: customers.id });
  customerId = cust.id;

  // Verknüpft die REFERENZIERTE Kasse mit dem Kunden → "benutzt".
  await db.insert(customerInsuranceHistory).values({
    customerId,
    insuranceProviderId: referencedProviderId,
    versichertennummer: `VN-${TAG}`,
    validFrom: "2024-01-01",
  } as any);

  // Voll-Snapshot VOR dem destruktiven Lauf: afterAll stellt die im Worker-DB
  // geseedeten (hier sonst "unbenutzten") Pflegekassen exakt wieder her, damit
  // der Cleanup keine nachfolgenden Tests im selben Worker beeinflusst.
  snapshotRows = await db.select().from(insuranceProviders);
});

afterAll(async () => {
  // 1) Vom Cleanup gelöschte Seed-Kassen wiederherstellen (FK-sicher: gelöscht =
  //    unreferenziert), inkl. Original-IDs; Sequence danach nachziehen.
  try {
    const present = new Set(
      (await db.select({ id: insuranceProviders.id }).from(insuranceProviders)).map((r) => r.id),
    );
    const missing = snapshotRows.filter((r) => !present.has(r.id));
    if (missing.length > 0) {
      await db.insert(insuranceProviders).values(missing);
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('insurance_providers','id'), GREATEST((SELECT MAX(id) FROM insurance_providers), 1))`,
      );
    }
  } catch {}
  // 2) Eigene Testdaten entfernen: Kunde (cascadet `customer_insurance_history`),
  //    dann die beiden eigenen Kassen, dann den Ledger-Eintrag.
  try {
    await db.delete(customers).where(eq(customers.id, customerId));
  } catch {}
  try {
    await db
      .delete(insuranceProviders)
      .where(inArray(insuranceProviders.id, [referencedProviderId, unusedProviderId]));
  } catch {}
  try {
    await db.execute(
      sql`DELETE FROM budget_migrations WHERE name = ${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME}`,
    );
  } catch {}
});

describe("Task #1262 — einmaliger Cleanup unbenutzter Pflegekassen", () => {
  it("löscht unbenutzte Kassen, behält referenzierte und ist exactly-once", async () => {
    const auditBefore = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "insurance_providers_cleanup"));

    const result = await applyUnusedInsuranceCleanupMigration();
    expect(result.outcome).toBe("applied");
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // Unbenutzte Kasse ist weg ...
    const unusedAfter = await db
      .select({ id: insuranceProviders.id })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, unusedProviderId));
    expect(unusedAfter).toHaveLength(0);

    // ... referenzierte Kasse bleibt erhalten.
    const refAfter = await db
      .select({ id: insuranceProviders.id })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, referencedProviderId));
    expect(refAfter).toHaveLength(1);

    // Ledger-Eintrag geschrieben.
    const ledger = await db.execute(
      sql`SELECT 1 FROM budget_migrations WHERE name = ${CLEANUP_UNUSED_INSURANCE_MIGRATION_NAME} LIMIT 1`,
    );
    expect((ledger as { rows?: unknown[] }).rows?.length ?? 0).toBe(1);

    // Genau ein zusätzlicher Audit-Eintrag.
    const auditAfter = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "insurance_providers_cleanup"));
    expect(auditAfter.length).toBe(auditBefore.length + 1);

    // Exactly-once: zweiter Aufruf → skipped, keine weitere Mutation.
    const second = await applyUnusedInsuranceCleanupMigration();
    expect(second.outcome).toBe("skipped");
    expect(second.deleted).toBe(0);

    const refStill = await db
      .select({ id: insuranceProviders.id })
      .from(insuranceProviders)
      .where(eq(insuranceProviders.id, referencedProviderId));
    expect(refStill).toHaveLength(1);
  });
});
