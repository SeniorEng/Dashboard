/**
 * Task #720 — Phase 1.2 DTO-Schranke: `GET /api/budget/:id/overview`
 * liefert exakt das Shape, das `BudgetOverviewDTO` (`shared/api/budget.ts`)
 * deklariert. Drift zwischen Backend-Response, Frontend-Erwartung und
 * Stats-V2-Per-Customer-Aggregat (Phase 2) wäre direkt sichtbar.
 *
 * Vor #720 war das Schema nur inline in `server/routes/budget.ts` deklariert
 * und in `client/src/components/budget/BudgetLedgerSection.tsx` parallel
 * dupliziert (Drift-Quelle, siehe `docs/budget-ssot-inventory.md` 3.6).
 *
 * Toleranz 0 für FELDER. Toleranz für WERTE: keine — Snapshot vergleicht
 * nur die Schlüssel-Topologie, nicht die Zahlen (die hängen vom
 * Scenario-Seed ab).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import type { BudgetOverviewDTO } from "@shared/api/budget";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

/** Erwartete Topologie pro DTO-Block. */
const EXPECTED_KEYS: Record<keyof BudgetOverviewDTO, string[]> = {
  entlastungsbetrag45b: [
    "totalAllocatedCents",
    "totalUsedCents",
    "availableCents",
    "plannedCents",
    "availableAfterPlannedCents",
    "currentMonthUsedCents",
    "currentMonthAvailableCents",
    "monthlyLimitCents",
    "carryoverCents",
    "carryoverExpiresAt",
    "currentYearAllocatedCents",
    "isCurrentlyActive",
  ],
  umwandlung45a: [
    "monthlyBudgetCents",
    "currentMonthAllocatedCents",
    "currentMonthUsedCents",
    "currentMonthAvailableCents",
    "isCurrentlyActive",
    "label",
  ],
  ersatzpflege39_42a: [
    "yearlyBudgetCents",
    "currentYearAllocatedCents",
    "currentYearUsedCents",
    "currentYearAvailableCents",
    "label",
  ],
};

describe("Phase 1.2 — BudgetOverview DTO-Shape (Task #720)", () => {
  it("`/budget/:id/overview` liefert exakt die Felder aus BudgetOverviewDTO", async () => {
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T720-DTO",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 59880 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 161200 },
      ],
      appointments: [],
    });
    try {
      const res = await apiGet<BudgetOverviewDTO>(
        `/api/budget/${scenario.customerId}/overview`,
      );
      const body = res.data;

      // Top-Level-Blöcke
      expect(Object.keys(body).sort()).toEqual(
        (Object.keys(EXPECTED_KEYS) as Array<keyof BudgetOverviewDTO>).sort(),
      );

      for (const [block, expectedKeys] of Object.entries(EXPECTED_KEYS) as Array<
        [keyof BudgetOverviewDTO, string[]]
      >) {
        const actual = Object.keys(body[block]).sort();
        expect(
          actual,
          `Block ${block}: unerwartete Feld-Topologie`,
        ).toEqual([...expectedKeys].sort());
      }

      // Spot-Check Typen (`null` ist gültig für nullable Felder).
      expect(typeof body.entlastungsbetrag45b.totalAllocatedCents).toBe("number");
      expect(typeof body.entlastungsbetrag45b.isCurrentlyActive).toBe("boolean");
      expect(typeof body.umwandlung45a.label).toBe("string");
      expect(typeof body.ersatzpflege39_42a.label).toBe("string");
      expect(
        body.entlastungsbetrag45b.monthlyLimitCents === null
        || typeof body.entlastungsbetrag45b.monthlyLimitCents === "number",
      ).toBe(true);
      expect(
        body.entlastungsbetrag45b.carryoverExpiresAt === null
        || typeof body.entlastungsbetrag45b.carryoverExpiresAt === "string",
      ).toBe(true);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
