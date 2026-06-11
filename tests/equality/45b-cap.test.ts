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
  getTodayDate,
  runCleanup,
} from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

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
      const date = weekdayInCurrentMonth();
      const scenario: BudgetScenarioHandle = await setupBudgetScenario({
        customerNamePrefix: "T427-45B",
        pflegegrad: 2,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        preferences: { budgetStartDate: "2026-01-01" },
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
        const today = getTodayDate();
        const estBefore = await apiGet<EstimateResponse>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
            `&hauswirtschaftMinutes=${c.hwMin}&alltagsbegleitungMinutes=${c.abMin}` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        const overviewBefore = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview`,
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
          `/api/budget/${scenario.customerId}/overview`,
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
 * Task #1171 (Audit-Ticket H / BUG-21) — Ein GESETZTES §45b-Monatslimit (> 0)
 * muss ab jetzt nicht nur die Anzeige, sondern auch die ECHTE Buchung kappen.
 *
 * Vorher: das Monatslimit reduzierte nur die Aufstockung, beim Buchen wurde
 * §45b aber bis zum gesamten Topf-Rest gezogen (Display ≠ Booking, sobald ein
 * Limit gesetzt war). Jetzt teilen Anzeige (`overview.availableCents` /
 * cost-estimate) UND Buchung (Cascade-Engine) DENSELBEN Cap-SSoT
 * (`computeCapSlot` → `computeCapRemaining`): §45b wird je Monat höchstens bis
 * (geklemmtes Limit − Monatsverbrauch) gefüllt, der Rest kaskadiert weiter
 * (hier in den uncapped Selbstzahler-Topf).
 *
 * Regression über 2h/1h/10h: deckt „Kosten unter Cap" (kein Überlauf) und
 * „Kosten über Cap" (Überlauf in Selbstzahler) in einem Lauf ab.
 */
describe("Equality §45b — SET-Monatslimit cappt Anzeige UND Buchung (Task #1171)", () => {
  const SET_LIMIT_CENTS = 5000; // 50 €/Monat (≤ gesetzliches §45b-Maximum)
  const POT_CENTS = 50000; // Topf weit über dem Monats-Cap → Cap ist die Schranke
  const setCases: Array<{ name: string; hwMin: number }> = [
    { name: "1h HW", hwMin: 60 },
    { name: "2h HW", hwMin: 120 },
    { name: "10h HW", hwMin: 600 },
  ];

  for (const c of setCases) {
    it(`[${c.name}] §45b-Anzeige zeigt Cap; Buchung kappt §45b auf (Limit − Monatsverbrauch), Rest kaskadiert`, async () => {
      const auth = await getAuthCookie();
      const date = weekdayInCurrentMonth();
      const scenario: BudgetScenarioHandle = await setupBudgetScenario({
        customerNamePrefix: "T1171-45B-CAP",
        pflegegrad: 3,
        billingType: "pflegekasse_gesetzlich",
        // Überlauf über den §45b-Cap muss irgendwo hin → uncapped Selbstzahler-Topf.
        acceptsPrivatePayment: true,
        preferences: { budgetStartDate: "2026-01-01" },
        types: [
          { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: SET_LIMIT_CENTS },
          { type: "umwandlung_45a", priority: 2, enabled: false },
          { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
        ],
        initialBalance: { type: "entlastungsbetrag_45b", amountCents: POT_CENTS, validFrom: "2026-01-01" },
      });
      try {
        const today = getTodayDate();
        const estBefore = await apiGet<EstimateResponse>(
          `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
            `&hauswirtschaftMinutes=${c.hwMin}&alltagsbegleitungMinutes=0` +
            `&travelKilometers=0&customerKilometers=0`,
        );
        const ov0 = await apiGet<OverviewResponse>(
          `/api/budget/${scenario.customerId}/overview`,
        );
        const displayedTotal = estBefore.data.totalCents;
        const availBefore = ov0.data.entlastungsbetrag45b.availableCents;
        const monthUsedBefore = ov0.data.entlastungsbetrag45b.currentMonthUsedCents;

        // ANZEIGE: §45b ist auf den SET-Cap begrenzt — NICHT den vollen Topf.
        expect(
          availBefore,
          `§45b availableCents=${availBefore} muss dem SET-Cap=${SET_LIMIT_CENTS} ` +
          `entsprechen (Topf-Rest ${POT_CENTS}+ wird durch den Monats-Cap überschrieben)`,
        ).toBe(SET_LIMIT_CENTS);
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
          `/api/budget/${scenario.customerId}/overview`,
        );
        const availAfter = ov1.data.entlastungsbetrag45b.availableCents;
        const monthUsedAfter = ov1.data.entlastungsbetrag45b.currentMonthUsedCents;

        // §45b trägt höchstens den Cap; der Rest geht in den Selbstzahler-Topf.
        const expected45bPortion = Math.min(displayedTotal, SET_LIMIT_CENTS);

        // Invariante A: Anzeige der GESAMT-Termin-Kosten == real gebuchter Betrag
        // (über alle Cascade-Töpfe). Display == Booking bleibt exakt.
        expect(
          booking.totalBookedAbsCents,
          `cost-estimate.totalCents=${displayedTotal} weicht von ` +
          `Engine-Buchung=${booking.totalBookedAbsCents} ab`,
        ).toBe(displayedTotal);

        // Invariante B: §45b-Topf-Rest fällt um exakt den gecappten Anteil.
        expect(
          availBefore - availAfter,
          `§45b availableCents-Δ (${availBefore}→${availAfter}) muss dem ` +
          `gecappten §45b-Anteil=${expected45bPortion} entsprechen`,
        ).toBe(expected45bPortion);
        expect(availAfter).toBe(SET_LIMIT_CENTS - expected45bPortion);

        // Invariante C: §45b-Monatsverbrauch reagiert exakt um den gecappten Anteil.
        expect(monthUsedAfter - monthUsedBefore).toBe(expected45bPortion);

        // Invariante D: Σ exakt in Integer-Cents über alle Cascade-Töpfe.
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
