/**
 * Task #1348 — §45b-Verfügbarkeits-SSoT `netAvailable45bAt` (Integration, DB + Server).
 *
 * Prüft die beiden Holds-Kontexte und die Floor-/Fehlbetrag-Invariante des
 * Alrik-Gates DIREKT gegen die DB (planHold ist nicht gegated, der Engine-Aufruf
 * läuft auch ohne `BUDGET_HARD_HOLDS`):
 *
 *   - READER-Kontext (`holds: "subtract"`) zieht aktive Hard-Holds ab.
 *   - FORECAST-Kontext (`holds: "ignore"`) zieht sie NICHT ab und ist damit
 *     deckungsgleich zum heutigen `getBudgetSummary().availableCents` (der die
 *     geplanten Kosten ohnehin selbst zählt — sonst Doppelzählung, #1340).
 *   - `availableCents` ist in BEIDEN Kontexten auf 0 gefloored; ein Fehlbetrag
 *     bleibt als negativer `allocated − consumedNet`-Saldo sichtbar (#95).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { netAvailable45bAt } from "../../server/storage/budget/net-available-45b";
import { getBudgetSummary } from "../../server/storage/budget/summary-queries";
import { planHold } from "../../server/storage/budget/reservation-storage";
import { getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";

/** Deterministischer Werktag (Mo–Fr) im aktuellen Monat. */
function pastWeekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

describe("Task #1348 — netAvailable45bAt (Holds-Kontexte + Floor)", () => {
  let scenario: BudgetScenarioHandle | undefined;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
      scenario = undefined;
    }
  });

  it("Reader-Kontext zieht aktive Holds ab, Forecast-Kontext nicht (== getBudgetSummary)", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T1348-HOLDS",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    const customerId = scenario.customerId;
    const [appointmentId] = scenario.appointmentIds;

    // Aktiven Hard-Hold direkt anlegen (planHold ist nicht gegated).
    const plan = await planHold({
      customerId,
      appointmentId,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
    });
    expect(plan.heldCents).toBeGreaterThan(0);

    const subtract = await netAvailable45bAt(customerId, date, { holds: "subtract" });
    const ignore = await netAvailable45bAt(customerId, date, { holds: "ignore" });

    // Holds sind in BEIDEN Ergebnissen transparent sichtbar ...
    expect(subtract.holdsCents).toBeGreaterThan(0);
    expect(ignore.holdsCents).toBe(subtract.holdsCents);
    // ... wirken aber nur im Reader-Kontext auf availableCents.
    expect(ignore.availableCents).toBeGreaterThan(0);
    expect(subtract.availableCents).toBe(
      Math.max(0, ignore.availableCents - subtract.holdsCents),
    );
    expect(ignore.availableCents - subtract.availableCents).toBe(subtract.holdsCents);

    // Forecast-Kontext == heutiger getBudgetSummary().availableCents — beide
    // ignorieren Holds, kein manual_adjustment/excluded in diesem Szenario.
    const summary = await getBudgetSummary(customerId, undefined, undefined, date);
    expect(ignore.availableCents).toBe(summary.availableCents);

    // Floor-Invariante: availableCents nie negativ.
    expect(subtract.availableCents).toBeGreaterThanOrEqual(0);
    expect(ignore.availableCents).toBeGreaterThanOrEqual(0);
  });

  it("availableCents auf 0 gefloored, Fehlbetrag bleibt als negativer Saldo sichtbar (#95)", async () => {
    const today = new Date().toISOString().split("T")[0];
    const year = new Date().getFullYear();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T1348-FLOOR",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        {
          type: "entlastungsbetrag_45b",
          priority: 1,
          enabled: true,
          monthlyLimitCents: null,
          validFrom: `${year}-01-01`,
        },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
    });
    const customerId = scenario.customerId;

    const before = await netAvailable45bAt(customerId, today, { holds: "subtract" });
    expect(before.allocatedCents).toBeGreaterThan(0);
    // Noch kein Verbrauch / keine Holds → available == allocated.
    expect(before.availableCents).toBe(before.allocatedCents);

    // Über die gesamte Allocation hinaus verbrauchen. Die Engine würde Overdraft
    // hart blocken — hier testen wir die reine Floor-Mathematik der SSoT, daher
    // ein direkter consumption-Eintrag (negativer amountCents = Verbrauch).
    const overspendCents = before.allocatedCents + 50000;
    await db.insert(budgetTransactions).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: today,
      transactionType: "consumption",
      amountCents: -overspendCents,
    });

    const after = await netAvailable45bAt(customerId, today, { holds: "subtract" });
    const afterForecast = await netAvailable45bAt(customerId, today, { holds: "ignore" });

    // availableCents NIE negativ (Alrik-Gate: auf 0 gefloored, in BEIDEN Kontexten) ...
    expect(after.availableCents).toBe(0);
    expect(afterForecast.availableCents).toBe(0);
    // ... aber der Fehlbetrag bleibt als negativer (allocated − consumedNet)-Saldo
    // sichtbar, NICHT aus dem gefloorten Wert abgeleitet.
    expect(after.consumedNetCents).toBe(overspendCents);
    expect(after.allocatedCents - after.consumedNetCents).toBeLessThan(0);
  });
});
