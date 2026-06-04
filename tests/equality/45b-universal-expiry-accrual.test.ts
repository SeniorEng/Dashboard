/**
 * Task #959 — Universelles §45b-Verfalls-/Akkumulations-Modell.
 *
 * Pinnt die vier Lücken, durch die ALT-, Legacy-, manuelle und neue Kunden
 * mehr §45b zeigen konnten, als rechtlich möglich ist:
 *
 *   (1) Legacy/Manueller Anker → unbegrenzte Monatsaufstockung über Jahre.
 *       Fix: Verfalls-Boden im Lesepfad bodet `allocStart` auf das relevante
 *       Fenster (1. Halbjahr: Vorjahr + laufendes Jahr; ab Juli: laufendes Jahr).
 *   (2) Vorjahres-Startwert (`initial_balance`) jenseits des Fensters wird weiter
 *       gezählt. Fix: IB-Supersession (`year < ibFloorYear` → ausgeschlossen).
 *   (4) Jahr mit Startwert rollte sein Restguthaben NICHT in einen Carryover.
 *       Fix: `ensureYearlyCarryover45b` verarbeitet IB-Jahre wieder.
 *   (3) Start-/Übertragswert über der Obergrenze bei der Anlage. Fix:
 *       `/initial-budget` weist zu hohe Werte mit 400 ab (Cap-SSoT).
 *
 * Lesepfad-Tests verwenden einen festen `asOfDate` im 1. Halbjahr (2026-05-27),
 * damit das Fenster = {Vorjahr 2025, laufendes Jahr 2026} deterministisch ist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings } from "@shared/schema";
import {
  calculateAllocatedCents,
  syncCarryoverAndExpiry,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import { upsertBudgetPreferences } from "../../server/storage/budget/preferences-storage";
import {
  apiPost,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;
const MONTHLY = 13_100; // gesetzliche §45b-Monatsaufstockung in Cent

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function fresh45b(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T959_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const customerId = c.id as number;
  await db.delete(customerBudgetTypeSettings).where(
    eq(customerBudgetTypeSettings.customerId, customerId),
  );
  await db.insert(customerBudgetTypeSettings).values({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    enabled: true,
    priority: 1,
    monthlyLimitCents: null,
    yearlyLimitCents: null,
    validFrom: null,
    validTo: null,
  });
  return customerId;
}

describe("Task #959 — universeller §45b-Verfall & Akkumulations-Cap", () => {
  it("Lücke 1: Legacy-Anker (2020) akkumuliert NICHT jahrelang — Boden = Vorjahr im 1. Halbjahr", async () => {
    const customerId = await fresh45b("T959-LEGACY");

    // Legacy-/Altbestand-Anker weit in der Vergangenheit (manuell gesetzt → wird
    // NICHT auf das laufende Jahr gebodet, nur der Verfalls-Boden greift).
    await upsertBudgetPreferences({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: null,
      budgetStartDate: "2020-01-01",
    });

    const total = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Fenster im 1. Halbjahr 2026 = Jan 2025 .. Mai 2026 = 17 Monate × 131 €.
    // KEINE Akkumulation seit 2020 (das wären 77 Monate).
    expect(total).toBe(17 * MONTHLY);
    expect(total).not.toBe(77 * MONTHLY);
  });

  it("Lücke 2: Vorjahres-Startwert für ein abgelaufenes Jahr (2024) trägt 0 € bei", async () => {
    const customerId = await fresh45b("T959-STALE-IB");

    // Aktueller Accrual-Anker im laufenden Jahr ...
    await upsertBudgetPreferences({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: null,
      budgetStartDate: "2026-01-01",
    });
    // ... aber ein alter Startwert von 2024 liegt noch herum (vor dem Boden 2025).
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2024,
      month: 6,
      amountCents: 99_999,
      validFrom: "2024-06-01",
      expiresAt: null,
    });

    const total = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: "2026-05-27" },
    );

    // Accrual startet 2026-01 (budgetStartDate) → Jan .. Mai 2026 = 5 × 131 €.
    // Der 2024er-Startwert (99.999) liegt unter dem Boden 2025 und wird per
    // IB-Supersession ausgeschlossen (alt: 65.500 + 99.999 = Doppel-Verfügbarkeit).
    expect(total).toBe(5 * MONTHLY);
    expect(total).not.toBe(5 * MONTHLY + 99_999);
  });

  it("Lücke 4: ein Jahr mit Startwert rollt sein Restguthaben in genau einen Carryover", async () => {
    const customerId = await fresh45b("T959-IB-ROLL");

    // Anker im Vorjahr 2025 + Startwert für 2025 → 2025 ist ein abgelaufenes
    // Jahr mit unverbrauchtem Guthaben, das in einen 2026er-Carryover gehört.
    await upsertBudgetPreferences({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: null,
      budgetStartDate: "2025-01-01",
    });
    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2025,
      month: 1,
      amountCents: MONTHLY,
      validFrom: "2025-01-01",
      expiresAt: null,
    });

    // Vorher (Task #101): kein Carryover, weil 2025 einen Startwert hatte.
    await syncCarryoverAndExpiry(customerId);

    const carryovers = await db
      .select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ));

    const carryover2026 = carryovers.filter(c => c.year === 2026);
    expect(carryover2026).toHaveLength(1);
    expect(carryover2026[0].amountCents).toBeGreaterThan(0);
    expect(carryover2026[0].validFrom).toBe("2026-01-01");
    expect(carryover2026[0].expiresAt).toBe("2026-06-30");
  });

  it("Lücke 3: /initial-budget weist einen §45b-Startwert über der Obergrenze mit 400 ab", async () => {
    const customerId = await fresh45b("T959-CAP");

    // Startmonat Mai 2026 → maximal Jan..Mai = 5 Monate ansammelbar (Obergrenze
    // 5 × 131 €, selbst bei beliebig altem Anker). Ein Startwert von 6 × 131 €
    // ist rechtlich unmöglich und MUSS abgewiesen werden.
    const res = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 6 * MONTHLY,
      carryoverAmountCents: 0,
      budgetStartDate: "2026-05-15",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("BUDGET_45B_START_VALUE_EXCEEDED");
  });
});
