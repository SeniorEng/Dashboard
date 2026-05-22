/**
 * Task #578 — Sicherheitstest für die Backfill-Migration
 * `backfill-budget-historization` (Task #440).
 *
 * Diese Migration schreibt zwar keine Audit-Einträge (reine DDL- &
 * Defensiv-Backfills), mutiert aber produktive Tabellen. Wir prüfen:
 *   - **Tuple-Mismatch No-Op**: Zeilen mit bereits gesetztem `valid_from`
 *     werden nicht überschrieben.
 *   - **Idempotenz**: zweiter Lauf ändert keine Zeile (Helper-Snapshot
 *     identisch); CREATE/DROP-DDL läuft kollisionsfrei durch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  customers,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { backfillBudgetHistorization } from "../../server/startup/backfill-budget-historization";
import { assertSecondRunIsNoOp } from "./backfill-guard-pattern";
import { uniqueId } from "../test-utils";

const TAG = `t578-hist-${uniqueId()}`;
let customerId: number;
const createdCustomerIds: number[] = [];
const settingsIds: number[] = [];

beforeAll(async () => {
  const [row] = await db.insert(customers).values({
    name: `T578-hist-${TAG}`,
    address: `Backfill-Teststraße 1, 10115 Berlin`,
    vorname: "T578",
    nachname: `hist-${TAG}`,
    billingType: "selbstzahler",
  } as any).returning({ id: customers.id });
  customerId = row.id;
  createdCustomerIds.push(row.id);
});

afterAll(async () => {
  if (settingsIds.length > 0) {
    await db.delete(customerBudgetTypeSettings)
      .where(inArray(customerBudgetTypeSettings.id, settingsIds));
  }
  for (const id of createdCustomerIds) {
    try { await db.delete(customers).where(eq(customers.id, id)); } catch {}
  }
});

beforeEach(async () => {
  await db.delete(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
  settingsIds.length = 0;
});

async function snapshot(ids: number[]) {
  if (ids.length === 0) return { data: [], auditCount: 0 };
  const res = await db.execute(sql`
    SELECT id,
           valid_from::text AS vf,
           valid_to::text AS vt
    FROM customer_budget_type_settings
    WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})
    ORDER BY id
  `);
  return { data: res.rows as unknown[], auditCount: 0 };
}

describe("Task #578 — backfill-budget-historization Sicherheits-Tests", () => {
  it("Tuple-Mismatch: Zeilen mit gesetztem valid_from werden NICHT überschrieben", async () => {
    const fixedFrom = new Date("2024-06-15");
    const [row] = await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      validFrom: fixedFrom,
    } as any).returning({ id: customerBudgetTypeSettings.id });
    settingsIds.push(row.id);

    await backfillBudgetHistorization();

    const after = await db.execute(sql`
      SELECT valid_from::text AS vf FROM customer_budget_type_settings WHERE id = ${row.id}
    `);
    expect((after.rows[0] as { vf: string }).vf).toBe("2024-06-15");
  });

  it("Idempotenz: zweiter Lauf ist No-Op (gleicher Snapshot)", async () => {
    // Mischung: 1 Zeile mit explizitem valid_from, eine mit NULL via raw SQL.
    const [r1] = await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      validFrom: new Date("2023-03-01"),
    } as any).returning({ id: customerBudgetTypeSettings.id });
    settingsIds.push(r1.id);

    // raw SQL, um valid_from explizit auf NULL zu setzen (Drizzle .insert
    // würde Default greifen lassen).
    const r2Insert = await db.execute(sql`
      INSERT INTO customer_budget_type_settings (customer_id, budget_type, valid_from)
      VALUES (${customerId}, 'pflegesachleistung_36', NULL)
      RETURNING id
    `);
    const r2Id = (r2Insert.rows[0] as { id: number }).id;
    settingsIds.push(r2Id);

    await assertSecondRunIsNoOp({
      label: "backfill-budget-historization",
      run: () => backfillBudgetHistorization(),
      snapshot: () => snapshot([r1.id, r2Id]),
    });

    // Nach erstem Lauf: NULL-Zeile wurde auf 1970-01-01 gesetzt; danach stabil.
    const after2 = await db.execute(sql`
      SELECT valid_from::text AS vf FROM customer_budget_type_settings WHERE id = ${r2Id}
    `);
    expect((after2.rows[0] as { vf: string }).vf).toBe("1970-01-01");
  });
});
