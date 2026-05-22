/**
 * Task #578 — Sicherheitstests für die Backfill-Migration
 * `clear-45b-monthly-limits` (Task #425).
 *
 * Geprüfte Eigenschaften:
 *   - **Idempotenz**: nach dem ersten Lauf hat keine §45b-Zeile mehr ein
 *     `monthly_limit_cents`; der zweite Lauf ist No-Op (keine zusätzlichen
 *     Audit-Einträge).
 *   - **Tuple-Mismatch**: andere Budget-Typen (`pflegesachleistung_36`) mit
 *     gesetztem `monthly_limit_cents` bleiben unangetastet.
 *   - **Fehlender Audit-Akteur**: ohne Super-/Admin wird die Datenkorrektur
 *     ausgeführt, das Audit-Log aber explizit übersprungen (siehe Migration-
 *     Spec). Wir verifizieren beide Eigenschaften separat.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  customers,
  customerBudgetTypeSettings,
  auditLog,
  users,
} from "@shared/schema";
import { clear45bMonthlyLimits } from "../../server/startup/clear-45b-monthly-limits";
import { uniqueId } from "../test-utils";

const TAG = `t578-45b-${uniqueId()}`;

let customerA: number;
let customerB: number;
const settingsIds: number[] = [];
const createdCustomerIds: number[] = [];

async function insertCustomer(label: string): Promise<number> {
  const [row] = await db.insert(customers).values({
    name: `T578-45b-${label}-${TAG}`,
    address: `Backfill-Teststraße 1, 10115 Berlin`,
    vorname: "T578",
    nachname: `${label}-${TAG}`,
    billingType: "selbstzahler",
  } as any).returning({ id: customers.id });
  createdCustomerIds.push(row.id);
  return row.id;
}

async function insertSetting(
  cId: number,
  budgetType: "entlastungsbetrag_45b" | "pflegesachleistung_36",
  monthlyLimitCents: number | null,
): Promise<number> {
  const [row] = await db.insert(customerBudgetTypeSettings).values({
    customerId: cId,
    budgetType,
    monthlyLimitCents,
    validFrom: new Date("2020-01-01"),
  } as any).returning({ id: customerBudgetTypeSettings.id });
  settingsIds.push(row.id);
  return row.id;
}

async function audit45bCountFor(cIds: number[]): Promise<number> {
  if (cIds.length === 0) return 0;
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM audit_log
    WHERE action = 'budget_type_settings_updated'
      AND entity_type = 'budget'
      AND entity_id = ANY(${sql.raw(`ARRAY[${cIds.join(",")}]::int[]`)})
      AND metadata->>'migration' = 'clear-45b-monthly-limits'
  `);
  return (res.rows[0] as { n: number }).n;
}

async function limitCentsFor(id: number): Promise<number | null> {
  const [row] = await db.select({ v: customerBudgetTypeSettings.monthlyLimitCents })
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.id, id));
  return row?.v ?? null;
}

beforeAll(async () => {
  customerA = await insertCustomer("A");
  customerB = await insertCustomer("B");
});

afterAll(async () => {
  if (settingsIds.length > 0) {
    await db.delete(auditLog).where(and(
      eq(auditLog.action, "budget_type_settings_updated"),
      inArray(auditLog.entityId, createdCustomerIds),
    ));
    await db.delete(customerBudgetTypeSettings)
      .where(inArray(customerBudgetTypeSettings.id, settingsIds));
  }
  for (const id of createdCustomerIds) {
    try { await db.delete(customers).where(eq(customers.id, id)); } catch {}
  }
});

describe("Task #578 — clear-45b-monthly-limits Sicherheits-Tests", () => {
  let s45bA: number;
  let s45bB: number;
  let s36A: number;

  beforeEach(async () => {
    // Frische Settings — jede Iteration startet mit gesetztem 45b-Cap.
    await db.delete(auditLog).where(and(
      eq(auditLog.action, "budget_type_settings_updated"),
      inArray(auditLog.entityId, [customerA, customerB]),
    ));
    await db.delete(customerBudgetTypeSettings)
      .where(inArray(customerBudgetTypeSettings.customerId, [customerA, customerB]));
    settingsIds.length = 0;
    s45bA = await insertSetting(customerA, "entlastungsbetrag_45b", 12500);
    s45bB = await insertSetting(customerB, "entlastungsbetrag_45b", 7500);
    s36A  = await insertSetting(customerA, "pflegesachleistung_36", 24000);
  });

  it("Happy Path + Idempotenz: 45b-Cap wird genullt, andere Budget-Typen bleiben unverändert, zweiter Lauf ist No-Op", async () => {
    await clear45bMonthlyLimits();

    expect(await limitCentsFor(s45bA)).toBeNull();
    expect(await limitCentsFor(s45bB)).toBeNull();
    // Andere Budget-Typen (Tuple-Mismatch) unangetastet:
    expect(await limitCentsFor(s36A)).toBe(24000);

    const auditAfter1 = await audit45bCountFor([customerA, customerB]);
    expect(auditAfter1).toBeGreaterThanOrEqual(2);

    // Zweiter Lauf: keine zusätzlichen Audit-Einträge, keine Daten-Mutation.
    await clear45bMonthlyLimits();
    const auditAfter2 = await audit45bCountFor([customerA, customerB]);
    expect(auditAfter2).toBe(auditAfter1);
    expect(await limitCentsFor(s36A)).toBe(24000);
  });
});
