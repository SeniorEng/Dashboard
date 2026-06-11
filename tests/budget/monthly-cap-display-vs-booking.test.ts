/**
 * Task #425 — §45b Anzeige == Buchung im Jahrestopf-Modell.
 *
 * Vorher (Task #423): Monats-Cap führte zu Drift-Bug zwischen `availableCents`
 * (Topf-Rest) und `currentMonthAvailableCents` (Cap-Rest). Cost-Estimate und
 * Engine mussten denselben Cap-Wert nutzen.
 *
 * Nachher (Task #425): §45b OHNE gesetztes Monatslimit (`monthlyLimitCents`
 * null oder 0 = Sentinel „Jahrestopf ohne monatliche Aufstockung") hat KEINEN
 * Monats-Cap.
 *  - `monthlyLimitCents` ist im Summary `null`.
 *  - `currentMonthAvailableCents == availableCents` (gleicher Pot).
 *  - Cost-Estimate nutzt `availableCents` direkt — keine Drift möglich.
 *  - Termine im Folgemonat dürfen die zusätzliche Aufstockung mitnutzen.
 *
 * Abgrenzung Task #1171: Ein AUSDRÜCKLICH gesetztes Monatslimit (> 0) wirkt
 * seither sehr wohl als Fenster-Cap — in Anzeige UND Buchung über denselben
 * SSoT (`computeCapSlot`/`cap-math`). Dieses File deckt bewusst nur den
 * Null-/Sentinel-Fall (kein Cap) ab; die SET-Limit-Cap-Wirkung ist in
 * `tests/equality/45b-cap.test.ts` und `tests/budget/cap-math.test.ts` fixiert.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("Task #425 — §45b Jahrestopf: Anzeige == Buchung", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    // §45b OHNE Monats-Cap (monthlyLimitCents=null). Topf-Startwert 50000 ct
    // (500 €), aktueller Monat hat einen 60-min-HW-Termin dokumentiert
    // (~3800 ct verbraucht).
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T425-DISPLAY",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      pflegegradSeit: "2026-01-01",
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: "2026-01-01",
      },
      appointments: [
        {
          date: weekdayInCurrentMonth(),
          scheduledStart: "09:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "T425 Verbrauch im aktuellen Monat",
        },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("Overview liefert monthlyLimitCents=null und currentMonthAvailableCents==availableCents", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;

    expect(s45b.monthlyLimitCents).toBeNull();
    expect(s45b.currentMonthUsedCents).toBeGreaterThan(0);
    // Kein Cap mehr → currentMonthAvailable spiegelt den Topf-Rest 1:1.
    expect(s45b.currentMonthAvailableCents).toBe(s45b.availableCents);
  });

  it("Cost-Estimate für teuren Termin nutzt Topf-Rest (kein Cap-Engpass mehr)", async () => {
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.totalCents).toBeGreaterThan(0);
    // Topf hat 50000 ct - ~3800 ct = ~46200 ct übrig — der 60min-Termin (~3800 ct)
    // passt locker rein. Vorher (Task #423) hätte der Monats-Cap das geblockt.
    expect(res.data.isHardBlock).toBe(false);
    // Cap-spezifische Warnung darf nicht mehr auftauchen.
    if (res.data.warning) {
      expect(res.data.warning).not.toContain("Monats-Cap");
    }
    // Verfügbar im Cost-Estimate == Topf-Rest des Summarys.
    const overview = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.data.availableCents).toBe(overview.data.entlastungsbetrag45b.availableCents);
  });

  it("Cost-Estimate für Folgemonat nutzt zusätzlich aufgelaufene Aufstockung", async () => {
    const next = new Date();
    next.setDate(15);
    next.setMonth(next.getMonth() + 1);
    const nextMonthDate = next.toISOString().slice(0, 10);

    const today = getTodayDate();
    const todayRes = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    const nextRes = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${nextMonthDate}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(todayRes.status).toBe(200);
    expect(nextRes.status).toBe(200);

    // Im Folgemonat ist die monatliche Aufstockung (Default 131 €/Monat,
    // 13100 ct) zusätzlich verfügbar — entweder über die Auto-Allocation oder
    // über `calculateAllocated45b`. Auf jeden Fall darf die Verfügbarkeit im
    // Folgemonat nicht KLEINER sein als heute.
    expect(nextRes.data.availableCents).toBeGreaterThanOrEqual(todayRes.data.availableCents);
    // Auch im Folgemonat kein Hard-Block (Topf hat genug).
    expect(nextRes.data.isHardBlock).toBe(false);
  });

  it("§45b ohne gesetztes Monatslimit (null) liefert overview.monthlyLimitCents=null (kein Cap)", async () => {
    // Dieses Szenario setzt KEIN Monatslimit (monthlyLimitCents=null). In dem
    // Fall bleibt §45b der reine Jahrestopf ohne Fenster-Cap und das Overview-
    // Feld monthlyLimitCents ist null. (Ein ausdrücklich gesetztes Limit > 0
    // wirkt seit Task #1171 sehr wohl als Cap — abgedeckt in
    // tests/equality/45b-cap.test.ts, nicht hier.)
    const overview = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.data.entlastungsbetrag45b.monthlyLimitCents).toBeNull();
  });
});
