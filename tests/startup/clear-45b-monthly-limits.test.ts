/**
 * Task #603 — Die Backfill-Migration `clear-45b-monthly-limits` ist deaktiviert
 * (No-Op), weil §45b-`monthlyLimitCents` jetzt der per-Kunde konfigurierbare
 * "Unser Anteil"-Wert ist (reduziert monatliche Aufstockung, KEIN harter Cap).
 *
 * Dieser Test stellt sicher, dass die Migration konfigurierte Werte bei
 * Re-Deploys nicht mehr wegwirft — sonst würde jeder Server-Boot die
 * Kunden-Konfiguration zerstören.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customers, customerBudgetTypeSettings } from "@shared/schema";
import { clear45bMonthlyLimits } from "../../server/startup/clear-45b-monthly-limits";
import { uniqueId } from "../test-utils";

const TAG = `t603-45b-${uniqueId()}`;

let customerA: number;
const settingsIds: number[] = [];
const createdCustomerIds: number[] = [];

beforeAll(async () => {
  const [row] = await db.insert(customers).values({
    name: `T603-45b-A-${TAG}`,
    address: `Backfill-Teststraße 1, 10115 Berlin`,
    vorname: "T603",
    nachname: `A-${TAG}`,
    billingType: "selbstzahler",
  } as any).returning({ id: customers.id });
  customerA = row.id;
  createdCustomerIds.push(row.id);

  const [s] = await db.insert(customerBudgetTypeSettings).values({
    customerId: customerA,
    budgetType: "entlastungsbetrag_45b",
    monthlyLimitCents: 5000, // 50 € konfigurierter Anteil
    validFrom: new Date("2020-01-01"),
  } as any).returning({ id: customerBudgetTypeSettings.id });
  settingsIds.push(s.id);
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

describe("Task #603 — clear-45b-monthly-limits ist No-Op", () => {
  it("Konfigurierter §45b-Monats-Anteil bleibt nach Migrationsaufruf erhalten", async () => {
    await clear45bMonthlyLimits();

    const [row] = await db.select({ v: customerBudgetTypeSettings.monthlyLimitCents })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.id, settingsIds[0]));
    expect(row?.v).toBe(5000);

    // Auch ein zweiter Aufruf darf nichts ändern.
    await clear45bMonthlyLimits();
    const [row2] = await db.select({ v: customerBudgetTypeSettings.monthlyLimitCents })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.id, settingsIds[0]));
    expect(row2?.v).toBe(5000);
  });
});
