/**
 * Task #427 — Equality: Pflegegrad-abhängige Preise (Anzeige vs. Buchung).
 *
 * Vergleich:
 *   Anzeige  = `GET /api/budget/:customerId/cost-estimate` (Kostenvoranschlag im UI)
 *   Buchung  = ECHTE Konsum-Transaktion via `createConsumptionTransaction`
 *              (selber Pfad wie Termin-Dokumentation, siehe
 *              `server/routes/appointments.ts` PATCH …/document).
 *
 * Drift-Kategorie: Custom-Price wird beim Schreiben anders aufgelöst als beim
 * Anzeigen, falsche Pflegegrad-Rate, gerundete Minuten-Stückelung.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import {
  setupBudgetScenario,
} from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

function pastWeekday(): string {
  const d = new Date();
  for (let i = 1; i <= 14; i++) {
    const t = new Date(d);
    t.setDate(d.getDate() - i);
    if (t.getDay() === 0 || t.getDay() === 6) continue;
    return t.toISOString().slice(0, 10);
  }
  throw new Error("kein Werktag in den letzten 14 Tagen");
}

describe("Equality Pflegegrad-Preise — Cost-Estimate vs ECHTE Buchung", () => {
  const cases: Array<{ name: string; pg: 1 | 2 | 3 | 4 | 5; hw: number; ab: number }> = [
    { name: "PG3 60min HW", pg: 3, hw: 60, ab: 0 },
    { name: "PG2 90min HW + 30min AB", pg: 2, hw: 90, ab: 30 },
    { name: "PG4 45min AB nur", pg: 4, hw: 0, ab: 45 },
  ];

  for (const c of cases) {
    it(`[${c.name}] cost-estimate.totalCents == gebuchte Konsum-Cents`, async () => {
      const auth = await getAuthCookie();
      const date = pastWeekday();
      const scenario = await setupBudgetScenario({
        customerNamePrefix: `T427-PG${c.pg}`,
        pflegegrad: c.pg,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: true,
        preferences: { budgetStartDate: "2024-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: { type: "entlastungsbetrag_45b", amountCents: 100000, validFrom: "2024-01-01" },
      });
      try {
        const est = await apiGet<{ totalCents: number }>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${date}` +
            `&hauswirtschaftMinutes=${c.hw}&alltagsbegleitungMinutes=${c.ab}` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        const booked = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hw,
          abMinutes: c.ab,
          travelKm: 0,
          customerKm: 0,
          userId: auth.user.id,
        });
        expect(
          booked.totalBookedAbsCents,
          `Anzeige=${est.data.totalCents} ≠ Buchung=${booked.totalBookedAbsCents} (PG${c.pg})`,
        ).toBe(est.data.totalCents);
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});
