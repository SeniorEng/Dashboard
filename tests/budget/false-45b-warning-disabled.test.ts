import { afterAll, describe, expect, it } from "vitest";
import {
  getBudgetSummary,
  getMonthlyBudgetFitByAppointment,
} from "../../server/storage/budget/summary-queries";
import { setupBudgetScenario } from "../helpers/budget-scenarios";

// BUG-19 (Facette A) — Prod-Regression „Seidel, Wolfgang": ein Pflegekasse-Kunde
// mit explizit DEAKTIVIERTEM §45b (anspruchsberechtigt, aber Topf abgeschaltet)
// bekam fälschlich die Soft-Warnung „Dieser Termin überschreitet das verfügbare
// §45b-Budget in seinem Monat.".
//
// Ursache: `summary-queries.ts` suchte die §45b-Zeile mit `&& s.enabled` → eine
// deaktivierte Zeile sah aus wie eine FEHLENDE → Default-Aktivierung griff → der
// abgeschaltete (0 €) Topf erschien als aktiv → Überschreitungs-Marker. Der Fix
// zieht die Aktivität über die SSoT `resolve45bActivation`.
//
// Dieser Test pinnt beide betroffenen Lese-Orte in summary-queries: die
// Overview-Aktivität (`getBudgetSummary.isCurrentlyActive`) und die
// Termin-Vorausschau (`getMonthlyBudgetFitByAppointment`).

type Handle = Awaited<ReturnType<typeof setupBudgetScenario>>;

/** Nächster Werktag ~n Tage in der Zukunft (Termine an WE werden abgelehnt). */
function futureWeekday(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

describe("BUG-19 (Facette A) — deaktivierter §45b erzeugt keine falsche Budget-Warnung", () => {
  const handles: Handle[] = [];
  const date = futureWeekday(14);

  afterAll(async () => {
    for (const h of handles) await h.cleanup();
  });

  it("Pflegekasse mit DEAKTIVIERTEM §45b ⇒ Topf inaktiv & KEIN Überschreitungs-Marker", async () => {
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "BUG19A-DISABLED",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: false, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 120 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    handles.push(scenario);

    const summary = await getBudgetSummary(scenario.customerId, undefined, undefined, date);
    expect(summary.isCurrentlyActive).toBe(false);
    expect(summary.availableCents).toBe(0);

    // Deaktivierter §45b ⇒ kein Kontingent ⇒ die Vorausschau liefert keinen
    // Marker mit `fitsInMonthlyBudget:false` (früher: Fehlalarm).
    const fits = await getMonthlyBudgetFitByAppointment(scenario.customerId, date);
    expect(fits.every((f) => f.fitsInMonthlyBudget)).toBe(true);
  });

  it("Positiv-Kontrolle: AKTIVER §45b mit 0-€-Kontingent ⇒ Termin erzeugt Überschreitungs-Marker", async () => {
    // Beweist, dass die Vorausschau-Maschinerie bei aktivem, aber leerem Topf
    // sehr wohl einen `fitsInMonthlyBudget:false`-Marker produziert — der
    // deaktivierte Fall oben ist also keine leere/vacuous Zusicherung.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "BUG19A-ENABLED0",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 0 },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 120 }],
          document: false,
          travelKilometers: 0,
          customerKilometers: 0,
        },
      ],
    });
    handles.push(scenario);

    const summary = await getBudgetSummary(scenario.customerId, undefined, undefined, date);
    expect(summary.isCurrentlyActive).toBe(true);

    const fits = await getMonthlyBudgetFitByAppointment(scenario.customerId, date);
    expect(fits.some((f) => !f.fitsInMonthlyBudget)).toBe(true);
  });
});
