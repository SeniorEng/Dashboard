/**
 * Task #704 — Zeitliche §45b-Projektion für „Geplant"-Forecast.
 *
 * Bug-Hintergrund (Catrin-Barz-Fall): `getPlannedCostCents` summierte alle
 * zukünftigen Termine gegen den HEUTIGEN §45b-Pott. Damit fehlten in der
 * Anzeige
 *   - die monatlichen Auto-Aufstockungen zwischen heute und Termin-Datum
 *   - der Ablauf des Carryovers am 30.06.
 * Folge: Eine lange Recurring-Serie wurde fälschlich als „Budget reicht
 * nicht" gemeldet, obwohl jeder einzelne Termin in seinem eigenen Monat
 * vollständig durch die §45b-Aufstockung gedeckt wäre.
 *
 * Mechanik des Fixes: `calculateAllocated45b` akzeptiert jetzt
 * `projectFuture: true`. In diesem Modus extrapoliert sie monatlich bis
 * `asOfDate` (anstatt am heutigen Monat zu kappen) und filtert Carryover-
 * Beträge weiterhin via `expiresAt`. `getBudgetSummary` verwendet das,
 * um pro Termin-Monat zu prüfen, ob die bis dahin aufgelaufene Allokation
 * die kumulierte Buchung deckt — Fehlbeträge werden im neuen Feld
 * `plannedShortfallMonth` exponiert.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateAllocatedCents } from "../../server/storage/budget/allocation-storage";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup } from "../test-utils";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

const MONTHLY_45B_CENTS = 13100;

describe("Task #704 — §45b zeitliche Projektion (projectFuture)", () => {
  it("Default-Modus (asOfDate heute) cappt am aktuellen Monat — Termine 6 Monate in der Zukunft sehen NUR den heutigen Pott", async () => {
    const today = todayISO();
    const todayYear = parseInt(today.slice(0, 4), 10);
    const startDate = `${todayYear}-01-01`;
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T704-DEFAULT",
      pflegegrad: 3,
      pflegegradSeit: startDate,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null, validFrom: startDate },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 0, validFrom: startDate },
    });
    try {
      const allocToday = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: today },
      );
      const futureDate = `${todayYear + 1}-06-30`;
      const allocFutureNoProject = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: futureDate },
      );
      // Ohne projectFuture wird auf den aktuellen Monat gekappt — Wert bleibt
      // identisch zur „heute"-Allokation.
      expect(allocFutureNoProject).toBe(allocToday);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("projectFuture=true zählt monatliche Aufstockungen bis asOfDate dazu", async () => {
    const today = todayISO();
    const todayDate = new Date(today + "T00:00:00");
    const todayYear = todayDate.getFullYear();
    const todayMonth = todayDate.getMonth() + 1;
    const startDate = `${todayYear}-01-01`;
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T704-FORECAST",
      pflegegrad: 3,
      pflegegradSeit: startDate,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null, validFrom: startDate },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 0, validFrom: startDate },
    });
    try {
      const allocToday = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: today },
      );
      // 3 volle Monate in der Zukunft
      let targetYear = todayYear;
      let targetMonth = todayMonth + 3;
      while (targetMonth > 12) { targetMonth -= 12; targetYear++; }
      const lastDay = new Date(targetYear, targetMonth, 0).getDate();
      const futureMonthEnd = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const allocFutureProjected = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: futureMonthEnd, projectFuture: true },
      );
      // Erwartet: 3 zusätzliche Monatsaufstockungen über dem heutigen Pott.
      expect(allocFutureProjected - allocToday).toBe(3 * MONTHLY_45B_CENTS);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("projectFuture=true: ein Carryover, dessen expiresAt vor asOfDate liegt, fällt aus der projizierten Allokation heraus", async () => {
    const today = todayISO();
    const todayYear = parseInt(today.slice(0, 4), 10);
    // Carryover-Quelljahr = Vorjahr, Zieljahr = aktuelles Jahr; expiresAt =
    // 30.06. des Zieljahres laut §45b SGB XI Abs. 3.
    const sourceYear = todayYear - 1;
    const carryoverAmount = 9000;
    const startDate = `${todayYear}-01-01`;
    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T704-CARRYEXPIRY",
      pflegegrad: 3,
      pflegegradSeit: startDate,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null, validFrom: startDate },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 0, validFrom: startDate },
      carryover: { type: "entlastungsbetrag_45b", amountCents: carryoverAmount, year: sourceYear },
    });
    try {
      // Stichtag 1: 30.06.YYYY — Carryover noch gültig.
      const beforeExpiry = `${todayYear}-06-30`;
      const allocBeforeExpiry = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: beforeExpiry, projectFuture: true },
      );
      // Stichtag 2: 01.07.YYYY — Carryover abgelaufen.
      const afterExpiry = `${todayYear}-07-01`;
      const allocAfterExpiry = await calculateAllocatedCents(
        scenario.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: afterExpiry, projectFuture: true },
      );
      // Differenz = (1 Monatsaufstockung Juli) − (Carryover-Wegfall)
      // = MONTHLY_45B_CENTS − carryoverAmount.
      expect(allocAfterExpiry - allocBeforeExpiry).toBe(MONTHLY_45B_CENTS - carryoverAmount);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
