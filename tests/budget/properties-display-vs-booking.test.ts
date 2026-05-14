/**
 * Task #427 — Property-Test: Anzeige ≥ tatsächlich gebuchter Betrag (§45b).
 *
 * Invariant (aus Task-Spec):
 *
 *     displayedAvailableCents (Anzeige VOR Buchung)
 *         ≥
 *     consumedCents          (was die Engine danach tatsächlich gebucht hat)
 *
 * Sprich: Was im UI als „verfügbar" steht, MUSS eine obere Schranke für die
 * Engine-Buchung sein — der Nutzer darf nie weniger bekommen, als angezeigt.
 * Drift in die andere Richtung (Anzeige < Engine) wäre der Bug aus Task #423.
 *
 * Begrenzte Run-Zahl (10) wegen API-gebundenem Setup + Konsum pro Run;
 * seed=42 in `tests/setup.ts` pinned die Reproduzierbarkeit.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import {
  apiGet,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";

const RUNS = 10;

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function pastWeekday(): Promise<string> {
  const d = new Date();
  for (let i = 1; i <= 14; i++) {
    const t = new Date(d);
    t.setDate(d.getDate() - i);
    if (t.getDay() === 0 || t.getDay() === 6) continue;
    return t.toISOString().slice(0, 10);
  }
  throw new Error("kein Werktag in den letzten 14 Tagen");
}

async function getDisplayedAvailableCents(
  customerId: number,
  date: string,
): Promise<number> {
  const r = await apiGet<{ availableCents: number }>(
    `/api/budget/${customerId}/cost-estimate?date=${date}` +
      `&hauswirtschaftMinutes=0&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
  );
  return r.data.availableCents;
}

describe("Property §45b — Anzeige (verfügbar) ≥ Gebucht (Engine-Konsum)", () => {
  it("Invariante hält für zufällige Pott/Cap/Konsum-Kombinationen", async () => {
    const auth = await getAuthCookie();
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          potCents: fc.integer({ min: 1000, max: 100000 }),
          capCents: fc.integer({ min: 2000, max: 13100 }),
          requestedHwMinutes: fc.integer({ min: 30, max: 240 }),
          // Pro Run zufälligen Vorverbrauch (Carryover-Kontext) und einen
          // optional dokumentierten Termin im aktuellen Monat erzeugen,
          // damit der Eingaberaum die Spec-Dimensionen Carryover/Konsum/
          // Planung tatsächlich abdeckt.
          // 0 = kein Vorverbrauch, sonst Vielfaches von 15 (Service-Mindestslot).
          priorConsumedMinutes: fc.integer({ min: 0, max: 8 }).map((n) => n * 15),
          carryoverPriorityFirst: fc.boolean(),
        }),
        async ({ potCents, capCents, requestedHwMinutes, priorConsumedMinutes, carryoverPriorityFirst }) => {
          const date = await pastWeekday();
          const scenario = await setupBudgetScenario({
            customerNamePrefix: "T427-PROP",
            pflegegrad: 2,
            billingType: "pflegekasse_gesetzlich",
            acceptsPrivatePayment: false,
            preferences: { budgetStartDate: "2024-01-01" },
            types: [
              { type: "entlastungsbetrag_45b", priority: carryoverPriorityFirst ? 1 : 3, enabled: true, monthlyLimitCents: capCents },
              { type: "umwandlung_45a", priority: 2, enabled: false },
              { type: "ersatzpflege_39_42a", priority: carryoverPriorityFirst ? 3 : 1, enabled: false },
            ],
            initialBalance: { type: "entlastungsbetrag_45b", amountCents: potCents, validFrom: "2024-01-01" },
            appointments: priorConsumedMinutes > 0
              ? [
                  {
                    date,
                    scheduledStart: "07:00",
                    services: [{ code: "hauswirtschaft", durationMinutes: priorConsumedMinutes }],
                    document: true,
                    notes: "T427 Property prior consumption",
                  },
                ]
              : [],
          });
          try {
            // 1) ANZEIGE: was die UI dem Nutzer als verfügbar zeigt.
            const displayed = await getDisplayedAvailableCents(scenario.customerId, date);

            // 2) ENGINE: einen Termin erzeugen und bewusst MEHR konsumieren
            //    wollen, als angezeigt. Die Engine darf maximal `displayed`
            //    Cents tatsächlich buchen (alles darüber wird abgewiesen
            //    oder anteilig auf den Cap begrenzt).
            const [appt] = await db
              .insert(appointments)
              .values({
                customerId: scenario.customerId,
                assignedEmployeeId: scenario.employeeId,
                appointmentType: "kundentermin",
                date,
                scheduledStart: "08:00:00",
                scheduledEnd: "09:00:00",
                durationPromised: requestedHwMinutes,
                status: "scheduled",
                notes: "T427-Property",
              })
              .returning();
            // Service-Junction wird vom Cost-Calculator nicht zwingend
            // benötigt, aber wir legen sie konsistent zur Datensatz-Form an.
            const svcRes = await apiGet<Array<{ id: number; code: string }>>("/api/services");
            const hwService = svcRes.data.find((s) => s.code === "hauswirtschaft");
            if (hwService) {
              await db.insert(appointmentServices).values({
                appointmentId: appt.id,
                serviceId: hwService.id,
                plannedDurationMinutes: requestedHwMinutes,
              });
            }

            let consumedCents = 0;
            try {
              const tx = await createConsumptionTransaction({
                customerId: scenario.customerId,
                appointmentId: appt.id,
                transactionDate: date,
                hauswirtschaftMinutes: requestedHwMinutes,
                alltagsbegleitungMinutes: 0,
                travelKilometers: 0,
                customerKilometers: 0,
                userId: auth.user.id,
              });
              consumedCents = Math.abs(tx?.amountCents ?? 0);
            } catch (e) {
              // Engine darf bei "Budget reicht nicht" werfen; der gebuchte
              // Betrag ist dann 0 (was die Invariante trivial erfüllt).
              const msg = e instanceof Error ? e.message : String(e);
              if (!/Budget reicht nicht|Budget unzureichend|insufficient budget/i.test(msg)) {
                throw e;
              }
            }

            // Invariante: was die Engine tatsächlich gebucht hat, darf nie
            // mehr sein als das, was die Anzeige als verfügbar gezeigt hat.
            return consumedCents <= displayed;
          } finally {
            await scenario.cleanup();
          }
        },
      ),
      { numRuns: RUNS },
    );
  }, 600_000);
});
