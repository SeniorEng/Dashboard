/**
 * Task #427 — Equality: Reisekosten (Anzeige vs. ECHTE Buchung).
 *
 * Vergleich:
 *   Anzeige  = `cost-estimate.totalCents` mit Travel-/Customer-Kilometern.
 *   Buchung  = Summe aller Konsum-Transaktionen, die
 *              `createConsumptionTransaction` für denselben Request schreibt
 *              (selber Pfad wie Termin-Dokumentation).
 *
 * Drift-Kategorie: falsche Rundung von km, Cent-Stückelung der Travel-Rate,
 * vergessene customer_km-Position.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  getAuthCookie,
  getTodayDate,
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

describe("Equality Reisekosten — Cost-Estimate vs ECHTE Buchung", () => {
  const cases: Array<{ name: string; hw: number; travel: number; cust: number }> = [
    { name: "Standard 30min HW + 5km travel", hw: 30, travel: 5, cust: 0 },
    { name: "Nur Customer-km (keine Anfahrt)", hw: 30, travel: 0, cust: 12 },
    { name: "Beide km kombiniert", hw: 30, travel: 7.5, cust: 3.2 },
  ];

  for (const c of cases) {
    it(`[${c.name}] cost-estimate.totalCents == gebuchte Konsum-Cents`, async () => {
      const auth = await getAuthCookie();
      const date = getTodayDate();
      const scenario = await setupBudgetScenario({
        customerNamePrefix: "T427-TRV",
        pflegegrad: 3,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: true,
        preferences: { budgetStartDate: "2024-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: { type: "entlastungsbetrag_45b", amountCents: 50000, validFrom: "2024-01-01" },
      });
      try {
        const est = await apiGet<{ totalCents: number }>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${date}` +
            `&hauswirtschaftMinutes=${c.hw}&alltagsbegleitungMinutes=0` +
            `&travelKilometers=${c.travel}&customerKilometers=${c.cust}`,
        );
        const booked = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hw,
          abMinutes: 0,
          travelKm: c.travel,
          customerKm: c.cust,
          userId: auth.user.id,
        });
        expect(
          booked.totalBookedAbsCents,
          `Anzeige=${est.data.totalCents} ≠ Buchung=${booked.totalBookedAbsCents} ` +
          `(travel=${c.travel}km, cust=${c.cust}km)`,
        ).toBe(est.data.totalCents);
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});
