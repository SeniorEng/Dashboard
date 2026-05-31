/**
 * Task #874 — Budget GF Phase 4 Equality: unified Reader vs Legacy-Summary.
 *
 * Verifiziert die Shadow-Read-Invariante (I18): der unified Reader
 * (`readUnifiedBudgetAvailability`) liefert pro Topf dieselbe Verfügbarkeit wie
 * die Legacy-Summary-Reader — für die Fälle, in denen beide Pfade
 * strukturell identisch rechnen:
 *  - §45a / §39+§42a: beide leiten `usedInWindow` über `computeCapSlot` ab ⇒
 *    Drift MUSS 0 sein.
 *  - §45b OHNE `manual_adjustment`: Legacy summiert all-time
 *    consumption+write_off−reversal, unified bis asOf-Datum; ohne
 *    `manual_adjustment` und ohne zukünftige Buchungen ist die Drift 0.
 *
 * BEWUSST NICHT abgedeckt (Soak-Aufgabe, Phase-6-Reconciliation): §45b MIT
 * `manual_adjustment` driftet, weil Legacy den manual_adjustment all-time
 * subtrahiert, der unified Reader (= getAvailableForDate-Mathematik) nicht.
 * Legacy bleibt diese Phase SSoT — die Drift wird vom Soak überwacht, nicht
 * hier reconciled.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAuthCookie, runCleanup } from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { compareUnifiedVsLegacy } from "../../server/storage/budget/shadow-read";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

function firstOfMonthISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

describe("Equality — unified Reader vs Legacy-Summary (Task #874 I18)", () => {
  it("§45a + §39/§42a: keine Drift (beide rechnen über computeCapSlot)", async () => {
    const firstOfMonth = firstOfMonthISO();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T874-CAP",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfMonth },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false },
        { type: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 74360 },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 168700 },
      ],
      appointments: [],
    });
    try {
      const result = await compareUnifiedVsLegacy(scenario.customerId);
      const drift45a = result.pots.find((p) => p.budgetType === "umwandlung_45a")!;
      const drift39 = result.pots.find((p) => p.budgetType === "ersatzpflege_39_42a")!;
      expect(
        drift45a.deltaCents,
        `§45a Drift unified=${drift45a.unifiedAvailableCents} legacy=${drift45a.legacyAvailableCents}`,
      ).toBe(0);
      expect(
        drift39.deltaCents,
        `§39/§42a Drift unified=${drift39.unifiedAvailableCents} legacy=${drift39.legacyAvailableCents}`,
      ).toBe(0);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("§45b ohne manual_adjustment: keine Drift", async () => {
    const firstOfMonth = firstOfMonthISO();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T874-45B",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfMonth },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      appointments: [],
    });
    try {
      const result = await compareUnifiedVsLegacy(scenario.customerId);
      const drift45b = result.pots.find((p) => p.budgetType === "entlastungsbetrag_45b")!;
      expect(
        drift45b.deltaCents,
        `§45b Drift unified=${drift45b.unifiedAvailableCents} legacy=${drift45b.legacyAvailableCents} ` +
        `(ohne manual_adjustment muss die Drift 0 sein)`,
      ).toBe(0);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
