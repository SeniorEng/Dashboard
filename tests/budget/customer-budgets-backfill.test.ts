/**
 * Task #728 (Phase 2.1) — Backfill `customer_budgets` →
 * `customer_budget_type_settings`.
 *
 * Verifiziert für 3 Szenarien:
 *   A) Kunde mit `customer_budgets`, KEINE Type-Settings vorhanden →
 *      Backfill legt exakt eine offene Zeile pro Nicht-Null-Topf an, mit
 *      korrektem Mapping (45b/45a → monthly, 39_42a → yearly) und dem
 *      `valid_from` aus der Quellzeile.
 *   B) Idempotenz: zweiter Backfill-Lauf erzeugt KEINE weitere Zeile.
 *   C) Kunde mit bereits existierender Type-Settings-Zeile für 45b →
 *      Backfill überschreibt sie NICHT, auch wenn `customer_budgets`
 *      einen anderen Wert hätte. Die anderen Töpfe (45a/39_42a) werden
 *      aber regulär migriert.
 *
 * Zusammen sichern die drei Fälle den Vertrag „Backfill ist additiv und
 * GoBD-konform — bestehende Konfigurationen sind unantastbar".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  customerBudgets,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { backfillCustomerBudgetsToTypeSettings } from "../../server/startup/backfill-customer-budgets-to-typesettings";
import { createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T728_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

async function clearTypeSettings(customerId: number): Promise<void> {
  await db.delete(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
}

async function listSettings(customerId: number) {
  return db.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
}

describe("Task #728 — Backfill customer_budgets → customer_budget_type_settings", () => {
  it("A) Mappt Nicht-Null-Beträge in Type-Settings (45b/45a → monthly, 39 → yearly)", async () => {
    const customerId = await freshCustomer("T728-A");
    await clearTypeSettings(customerId);

    await db.insert(customerBudgets).values({
      customerId,
      entlastungsbetrag45b: 12500,
      pflegesachleistungen36: 80000,
      verhinderungspflege39: 169400,
      validFrom: "2025-06-01",
      validTo: null,
    });

    await backfillCustomerBudgetsToTypeSettings();

    const settings = await listSettings(customerId);
    expect(settings).toHaveLength(3);

    const s45b = settings.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(s45b).toMatchObject({
      enabled: true,
      priority: 1,
      monthlyLimitCents: 12500,
      yearlyLimitCents: null,
      validFrom: "2025-06-01",
      validTo: null,
    });

    const s45a = settings.find(s => s.budgetType === "umwandlung_45a");
    expect(s45a).toMatchObject({
      enabled: true,
      priority: 2,
      monthlyLimitCents: 80000,
      yearlyLimitCents: null,
      validFrom: "2025-06-01",
      validTo: null,
    });

    const s39 = settings.find(s => s.budgetType === "ersatzpflege_39_42a");
    expect(s39).toMatchObject({
      enabled: true,
      priority: 3,
      monthlyLimitCents: null,
      yearlyLimitCents: 169400,
      validFrom: "2025-06-01",
      validTo: null,
    });
  });

  it("B) Idempotenz: zweiter Lauf erzeugt keine neue Zeile", async () => {
    const customerId = await freshCustomer("T728-B");
    await clearTypeSettings(customerId);

    await db.insert(customerBudgets).values({
      customerId,
      entlastungsbetrag45b: 13100,
      pflegesachleistungen36: 0,
      verhinderungspflege39: 0,
      validFrom: "2024-01-01",
      validTo: null,
    });

    await backfillCustomerBudgetsToTypeSettings();
    const before = await listSettings(customerId);
    expect(before).toHaveLength(1);

    await backfillCustomerBudgetsToTypeSettings();
    const after = await listSettings(customerId);

    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].monthlyLimitCents).toBe(13100);
  });

  it("C) Bestehende Type-Settings-Zeile pro Topf wird NICHT überschrieben", async () => {
    const customerId = await freshCustomer("T728-C");
    await clearTypeSettings(customerId);

    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: 9000,
      yearlyLimitCents: null,
      validFrom: "2023-01-01",
      validTo: null,
    });

    await db.insert(customerBudgets).values({
      customerId,
      entlastungsbetrag45b: 12500,
      pflegesachleistungen36: 70000,
      verhinderungspflege39: 0,
      validFrom: "2025-01-01",
      validTo: null,
    });

    await backfillCustomerBudgetsToTypeSettings();

    const s45b = await db.select()
      .from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
      ));
    expect(s45b).toHaveLength(1);
    expect(s45b[0].monthlyLimitCents).toBe(9000);
    expect(s45b[0].validFrom).toBe("2023-01-01");

    const s45a = await db.select()
      .from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, "umwandlung_45a"),
      ));
    expect(s45a).toHaveLength(1);
    expect(s45a[0].monthlyLimitCents).toBe(70000);
    expect(s45a[0].validFrom).toBe("2025-01-01");
  });
});
