/**
 * Task #716 — Equality-Test: `readBudgetTypeSettings` (SSoT) liefert pro
 * Modus DASSELBE wie der jeweilige Legacy-Getter (`getActiveBudgetTypeSettings`
 * / `getLatestBudgetTypeSettings` / `getLatestBudgetTypeSettingsWithTransition`).
 *
 * Drift-Schutz für Phase 1.1: die alten Wrapper bleiben als `@deprecated`
 * exportiert, dürfen aber bis zu ihrer Entfernung kein anderes Ergebnis
 * liefern als die konsolidierte API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import {
  customers,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { withGobdMutation } from "../helpers/gobd";
import {
  readBudgetTypeSettings,
  getActiveBudgetTypeSettings,
  getLatestBudgetTypeSettings,
  getLatestBudgetTypeSettingsWithTransition,
} from "../../server/storage/budget/preferences-storage";

const SUFFIX = `ssot-${Date.now()}`;

let customerId: number;

async function seed(): Promise<number> {
  const [c] = await db.insert(customers).values({
    name: `Equality-Test ${SUFFIX}`,
    address: "Teststr. 1, 10115 Berlin",
    billingType: "pflegekasse",
  } as any).returning({ id: customers.id });

  // Drei Zeilen für §45b: eine alte (geschlossen 2020), eine aktive (offen
  // ab 2024), und eine zukünftige (validFrom = morgen). So sind alle drei
  // Modi unterscheidbar:
  //   forDate(today)   → aktive
  //   forEdit          → zukünftige (Latest-Intent)
  //   withTransition   → zukünftige + effectiveToday = aktive
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrow = new Date(today.getTime() + 86400_000);
  const tomorrowISO = tomorrow.toISOString().slice(0, 10);

  // Partial-Unique-Index `(customer_id, budget_type) WHERE valid_to IS NULL`
  // erlaubt nur EINE offene Zeile pro Topf — historische Zeilen müssen
  // validTo gesetzt haben.
  await db.insert(customerBudgetTypeSettings).values([
    {
      customerId: c.id,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      validFrom: "2020-01-01",
      validTo: "2023-12-31",
    },
    {
      customerId: c.id,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: 12500,
      yearlyLimitCents: null,
      validFrom: "2024-01-01",
      validTo: todayStr,
    },
    {
      customerId: c.id,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: 13100,
      yearlyLimitCents: null,
      validFrom: tomorrowISO,
      validTo: null,
    },
  ] as any);

  return c.id;
}

async function cleanup(id: number): Promise<void> {
  // customer_budget_type_settings ist append-only (GoBD-Trigger Task #828) —
  // Hard-Delete im Test-Teardown nur über den transaktions-lokalen Bypass.
  await withGobdMutation((tx) =>
    tx.delete(customerBudgetTypeSettings).where(eq(customerBudgetTypeSettings.customerId, id)),
  );
  await db.delete(customers).where(eq(customers.id, id));
}

describe("readBudgetTypeSettings — Equality mit Legacy-Gettern (Task #716)", () => {
  beforeAll(async () => {
    customerId = await seed();
  });
  afterAll(async () => {
    await cleanup(customerId);
  });

  it("forDate(today) === getActiveBudgetTypeSettings(today)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ssot = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today });
    const legacy = await getActiveBudgetTypeSettings(customerId, today);
    expect(ssot).toEqual(legacy);
  });

  it("forEdit === getLatestBudgetTypeSettings", async () => {
    const ssot = await readBudgetTypeSettings(customerId, { kind: "forEdit" });
    const legacy = await getLatestBudgetTypeSettings(customerId);
    expect(ssot).toEqual(legacy);
  });

  it("withTransition === getLatestBudgetTypeSettingsWithTransition", async () => {
    const ssot = await readBudgetTypeSettings(customerId, { kind: "withTransition" });
    const legacy = await getLatestBudgetTypeSettingsWithTransition(customerId);
    expect(ssot).toEqual(legacy);
  });
});
