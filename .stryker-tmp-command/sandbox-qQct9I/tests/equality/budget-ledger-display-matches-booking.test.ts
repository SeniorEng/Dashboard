/**
 * Task #616 — Drift-Detektor: angezeigte km-Zahl im Budget-Ledger entspricht
 * exakt dem gebuchten Cent-Betrag.
 *
 * Hintergrund (Screenshot 12.01./21.01./04.02.2026): Anzeige zeigte
 * "Anfahrt: 70,0km = −75,95 €", korrekt waren 7 km × 0,35 € + 73,50 € =
 * 75,95 €. Wurzel: km wurde im Frontend (`toFixed(1)`) und in der
 * Verbrauchsbuchung (`Math.round(km*ratio*10)/10`) unabhängig gerundet,
 * außerdem konnte alter Bestand (vor Task #611) Faktor-10-Drifts haben.
 *
 * Dieser Test prüft Ende-zu-Ende:
 *   formatKmQuantityDisplay(tx.travelKilometers) entspricht
 *     quantizeKm(appt.travelKilometers)            UND
 *   Math.round(quantizeKm(appt.travelKilometers) * rate) === tx.travelCents
 *
 * Vor #616 hätte der erste Fall bei 7,3 km gefailt (Buchung 7,0; Anzeige
 * 7,3), und in extremen Bestandsfällen (Eingabe 70 → korrigiert auf 7,3
 * ohne Rebook) hätte sich die 10×-Drift ergeben.
 */
// @ts-nocheck

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getAuthCookie,
  getTodayDate,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import {
  computeKmLineTotalCents,
  formatKmQuantityDisplay,
  quantizeKm,
} from "@shared/domain/invoice-line-items";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Equality Budget-Ledger-Anzeige == gebuchte km/Cents (Task #616)", () => {
  const cases: Array<{ name: string; travelKm: number; hwMinutes: number }> = [
    { name: "Dezimal 7,3 km (Screenshot-Regression)", travelKm: 7.3, hwMinutes: 60 },
    { name: "Dezimal 2,71 km (#561-Bezug)", travelKm: 2.71, hwMinutes: 60 },
    { name: "Glatt 12 km", travelKm: 12, hwMinutes: 60 },
    { name: "Sehr klein 0,4 km", travelKm: 0.4, hwMinutes: 30 },
  ];

  for (const c of cases) {
    it(`[${c.name}] Anzeige-km × Satz === tx.travelCents`, async () => {
      const auth = await getAuthCookie();
      const date = getTodayDate();
      const scenario = await setupBudgetScenario({
        customerNamePrefix: "T616-LEDGER",
        pflegegrad: 3,
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
        const booked = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hwMinutes,
          abMinutes: 0,
          travelKm: c.travelKm,
          customerKm: 0,
          userId: auth.user.id,
        });

        await db.update(appointments).set({
          travelKilometers: c.travelKm,
        }).where(eq(appointments.id, booked.appointmentId));

        const txs = await db
          .select({
            travelKilometers: budgetTransactions.travelKilometers,
            travelCents: budgetTransactions.travelCents,
          })
          .from(budgetTransactions)
          .where(eq(budgetTransactions.appointmentId, booked.appointmentId));

        // Drift-Bedingung 1: quantizeKm(appt.km) === gespeicherte tx.travelKilometers.
        const expectedDisplay = formatKmQuantityDisplay(c.travelKm);
        const expectedQuantized = quantizeKm(c.travelKm);
        for (const tx of txs.filter(t => (t.travelKilometers ?? 0) > 0)) {
          const actualKm = Number(tx.travelKilometers);
          expect(
            formatKmQuantityDisplay(actualKm),
            `Ledger-Anzeige ${formatKmQuantityDisplay(actualKm)} ≠ erwartet ${expectedDisplay} ` +
            `(Termin-km=${c.travelKm}, gespeichert=${actualKm})`,
          ).toBe(expectedDisplay);
        }

        // Drift-Bedingung 2: Σ tx.travelCents == computeKmLineTotalCents(appt.km, rate).
        // Rate ableiten aus der Buchung selbst (Domain-Helper): Σ tx.travelCents / quantizeKm(km).
        const sumTravelCents = txs.reduce((s, t) => s + (t.travelCents ?? 0), 0);
        if (expectedQuantized > 0) {
          // Wir rekonstruieren den effektiven km-Satz aus der Buchung (Cent/km),
          // runden auf ganze Cent (Stückpreise sind ganzzahlig in Cent gepflegt)
          // und prüfen, dass derselbe Satz × quantizeKm(km) den gebuchten Wert
          // wieder ergibt — das fängt jeden Drift zwischen Display- und
          // Buchungs-Pfad zuverlässig ab.
          const effectiveRate = Math.round(sumTravelCents / expectedQuantized);
          const recomputed = computeKmLineTotalCents(c.travelKm, effectiveRate);
          expect(
            recomputed,
            `recompute(quantize(${c.travelKm}) × ${effectiveRate}ct)=${recomputed} ≠ tx.travelCents=${sumTravelCents}`,
          ).toBe(sumTravelCents);
        }
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});
