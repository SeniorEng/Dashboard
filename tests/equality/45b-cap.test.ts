/**
 * Task #427 — Equality §45b: Anzeige (cost-estimate) vs ECHTE Buchung.
 *
 * Hintergrund: §45b kennt seit Task #425 keinen Monats-Cap mehr (Jahrestopf).
 * Der historische Drift-Bug (Task #423) war: cost-estimate zeigt einen
 * verfügbaren Betrag X an, die tatsächliche Engine-Buchung weicht aber davon
 * ab — entweder weil sie weniger bucht (Anzeige zu optimistisch) oder weil
 * der Topf-Rest nach Buchung nicht um den angezeigten Betrag fällt.
 *
 * Dieser Test prüft beide Richtungen über den ECHTEN Schreibpfad
 * (`createConsumptionTransaction`, dieselbe Engine, die das Dokumentieren
 * eines Termins auslöst — siehe `server/routes/appointments.ts` und
 * `server/storage/budget/consumption-engine.ts`):
 *
 *  1) cost-estimate.totalCents (Anzeige der Termin-Kosten)
 *     == |sum(consumption-tx.amountCents)| (was die Engine tatsächlich bucht)
 *
 *  2) Δ overview.entlastungsbetrag45b.availableCents (vor → nach Buchung)
 *     == gebuchter Betrag (Anzeige des Topf-Rests reagiert exakt)
 *
 * Toleranz 0 — jede Cent-Drift wäre der Bug aus #423.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";
import { billingReferenceMonth, pastWeekdayInBillingMonth } from "../helpers/billing-month";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

interface OverviewResponse {
  entlastungsbetrag45b: {
    availableCents: number;
    currentMonthUsedCents: number;
  };
}

interface EstimateResponse {
  totalCents: number;
}

describe("Equality §45b — Cost-Estimate vs ECHTE Engine-Buchung", () => {
  const cases: Array<{
    name: string;
    potCents: number;
    hwMin: number;
    abMin: number;
    docPriorMinutes?: number;
  }> = [
    { name: "Frischer Pott + 60min HW Buchung", potCents: 50000, hwMin: 60, abMin: 0 },
    { name: "Pott mit Vorverbrauch + 30min HW + 30min AB", potCents: 50000, hwMin: 30, abMin: 30, docPriorMinutes: 60 },
    { name: "Knapper Pott (3000 ct) + 30min HW", potCents: 3000, hwMin: 30, abMin: 0 },
  ];

  for (const c of cases) {
    it(`[${c.name}] cost-estimate.totalCents == gebuchte Cents UND availableCents-Δ == gebucht`, async () => {
      const auth = await getAuthCookie();
      const date = pastWeekdayInBillingMonth();
      const scenario: BudgetScenarioHandle = await setupBudgetScenario({
        customerNamePrefix: "T427-45B",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        pflegegradSeit: "2026-01-01",
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: { type: "entlastungsbetrag_45b", amountCents: c.potCents, validFrom: "2026-01-01" },
        appointments: c.docPriorMinutes
          ? [
              {
                date,
                scheduledStart: "08:00",
                services: [{ code: "hauswirtschaft", durationMinutes: c.docPriorMinutes }],
                document: true,
                notes: "T427 Vorverbrauch",
              },
            ]
          : [],
      });
      try {
        // 1) ANZEIGE vor Buchung
        const estBefore = await apiGet<EstimateResponse>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${date}` +
            `&hauswirtschaftMinutes=${c.hwMin}&alltagsbegleitungMinutes=${c.abMin}` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        const overviewBefore = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${date}`,
        );
        const displayedTotal = estBefore.data.totalCents;
        const availableBefore = overviewBefore.data.entlastungsbetrag45b.availableCents;

        // 2) ECHTE BUCHUNG via Engine (selber Pfad wie Dokumentation)
        const booking = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hwMin,
          abMinutes: c.abMin,
          travelKm: 0,
          customerKm: 0,
          userId: auth.user.id,
        });

        // 3) ANZEIGE nach Buchung
        const overviewAfter = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${date}`,
        );
        const availableAfter = overviewAfter.data.entlastungsbetrag45b.availableCents;

        // Invariante A: Anzeige der Termin-Kosten == real gebuchter Betrag
        expect(
          booking.totalBookedAbsCents,
          `cost-estimate.totalCents=${displayedTotal} weicht von ` +
          `Engine-Buchung=${booking.totalBookedAbsCents} ab (Δ ${booking.totalBookedAbsCents - displayedTotal})`,
        ).toBe(displayedTotal);

        // Invariante B: Topf-Rest fällt um exakt den gebuchten Betrag
        expect(
          availableBefore - availableAfter,
          `overview.availableCents Δ (${availableBefore}→${availableAfter}=${availableBefore - availableAfter}) ` +
          `weicht von tatsächlich gebucht=${booking.totalBookedAbsCents} ab`,
        ).toBe(booking.totalBookedAbsCents);
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});

/**
 * §45b-Monatslimit = Aufstockungsrate, KEIN Buchungs-Cap (Ersatz für Task #1171).
 *
 * Alrik-Direktive: ein reines Monatslimit darf es NICHT geben; das §45b-Limit
 * muss bis zum Stichtag akkumulieren „wie das Budget akkumuliert". Das
 * konfigurierte §45b-Monatslimit ("Unser Anteil") wirkt daher AUSSCHLIESSLICH
 * als akkumulierende monatliche Aufstockungsrate in der Allocation
 * (`allocation-storage.monthlyAmountFor`) — NICHT als per-Kalendermonat-
 * Reset-Cap beim Buchen.
 *
 * Der frühere zweite Fenster-Cap (Task #1171/BUG-21) legte dasselbe Limit ein
 * ZWEITES Mal auf den bereits akkumulierten Topf (Doppel-Anwendung) und war die
 * Wurzel des wiederkehrenden §45b-Hard-Blocks beim Dokumentieren — derselbe
 * Symptom-Fall, den der Datenfix Task #423 (monthly_limit_cents → NULL) pro
 * Kunde reparierte. Er ist entfernt.
 *
 * Regression: ein Termin, dessen Kosten den per-Monat-Betrag (Limit) ÜBER-
 * steigen, aber im akkumulierten Jahrestopf Platz haben, muss VOLLSTÄNDIG aus
 * §45b gebucht werden — KEIN Überlauf in den Selbstzahler-Topf, KEIN Hard-Block.
 */
describe("Equality §45b — Monatslimit ist Aufstockungsrate, KEIN Buchungs-Cap", () => {
  const SET_LIMIT_CENTS = 5000; // 50 €/Monat Aufstockungsrate (≤ gesetzliches §45b-Maximum)
  const POT_CENTS = 50000; // akkumulierter Jahrestopf weit über der Monatsrate
  const setCases: Array<{ name: string; hwMin: number }> = [
    { name: "1h HW (unter Monatsrate)", hwMin: 60 },
    { name: "2h HW (ueber Monatsrate)", hwMin: 120 },
    { name: "10h HW (weit ueber Monatsrate, im Jahrestopf)", hwMin: 600 },
  ];

  for (const c of setCases) {
    it(`[${c.name}] §45b bucht voll aus dem akkumulierten Topf, kein Monats-Cap, kein Selbstzahler-Ueberlauf`, async () => {
      const auth = await getAuthCookie();
      const date = pastWeekdayInBillingMonth();
      const scenario: BudgetScenarioHandle = await setupBudgetScenario({
        customerNamePrefix: "T45B-NOCAP",
        pflegegrad: 3,
        billingType: "pflegekasse_gesetzlich",
        // Selbstzahler-Topf BEWUSST verfügbar: würde ein per-Monat-Cap noch
        // existieren, flösse der Überschuss hierher — der Test beweist, dass das
        // NICHT passiert (alles bleibt in §45b).
        acceptsPrivatePayment: true,
        pflegegradSeit: "2026-01-01",
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: SET_LIMIT_CENTS },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: { type: "entlastungsbetrag_45b", amountCents: POT_CENTS, validFrom: "2026-01-01" },
      });
      try {
        const estBefore = await apiGet<EstimateResponse>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${date}` +
            `&hauswirtschaftMinutes=${c.hwMin}&alltagsbegleitungMinutes=0` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        const ov0 = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${date}`,
        );
        const displayedTotal = estBefore.data.totalCents;
        const availBefore = ov0.data.entlastungsbetrag45b.availableCents;
        const monthUsedBefore = ov0.data.entlastungsbetrag45b.currentMonthUsedCents;

        // ANZEIGE: §45b zeigt den AKKUMULIERTEN Topf-Rest, NICHT die Monatsrate.
        // (Wäre der alte Monats-Cap aktiv, stünde hier exakt SET_LIMIT_CENTS.)
        expect(
          availBefore,
          `§45b availableCents=${availBefore} muss den akkumulierten Topf zeigen ` +
          `(deutlich > Monatsrate ${SET_LIMIT_CENTS}), kein per-Monat-Cap`,
        ).toBeGreaterThan(SET_LIMIT_CENTS);
        expect(monthUsedBefore).toBe(0);

        // ECHTE BUCHUNG via Engine (selber Pfad wie Dokumentation).
        const booking = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hwMin,
          abMinutes: 0,
          travelKm: 0,
          customerKm: 0,
          userId: auth.user.id,
        });

        const ov1 = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview?date=${date}`,
        );
        const availAfter = ov1.data.entlastungsbetrag45b.availableCents;
        const monthUsedAfter = ov1.data.entlastungsbetrag45b.currentMonthUsedCents;

        // Invariante A: Anzeige der Termin-Kosten == real gebuchter Betrag.
        expect(
          booking.totalBookedAbsCents,
          `cost-estimate.totalCents=${displayedTotal} weicht von ` +
          `Engine-Buchung=${booking.totalBookedAbsCents} ab`,
        ).toBe(displayedTotal);

        // Invariante B: §45b-Topf-Rest fällt um den VOLLEN Betrag — der gesamte
        // Termin wird aus §45b gebucht, NICHTS läuft in den Selbstzahler-Topf
        // (kein per-Monat-Cap, der bei >Monatsrate kaskadieren würde).
        expect(
          availBefore - availAfter,
          `§45b availableCents-Δ (${availBefore}→${availAfter}) muss dem vollen ` +
          `Termin-Betrag=${booking.totalBookedAbsCents} entsprechen (kein Überlauf)`,
        ).toBe(booking.totalBookedAbsCents);

        // Invariante C: §45b-Monatsverbrauch steigt um den VOLLEN Betrag — er ist
        // NICHT auf die Monatsrate gedeckelt.
        expect(monthUsedAfter - monthUsedBefore).toBe(booking.totalBookedAbsCents);

        // Invariante D: Σ exakt in Integer-Cents.
        expect(
          booking.transactionAmountsCents.every((n) => Number.isInteger(n)),
        ).toBe(true);
        expect(
          booking.transactionAmountsCents.reduce((s, n) => s + n, 0),
        ).toBe(booking.totalBookedAbsCents);
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});
