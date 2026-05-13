/**
 * Task #423 — Regression: Monats-Cap muss in Anzeige UND Buchung gleich wirken.
 *
 * Vorher (Bug): `availableCents` aus dem §45b-Summary ignorierte
 * `monthly_limit_cents`. Cost-Estimate zeigte deshalb das volle Topf-Guthaben
 * als "verfügbar" an, obwohl der Cap-Calculator beim Dokumentieren nur den
 * Cap-Rest freigab → Drift zwischen Anzeige und Buchung, irreführende
 * "Achtung Budget"-Warnung trotz scheinbar freiem Geld.
 *
 * Nachher: Neues `currentMonthAvailableCents` (in BudgetSummary) bildet
 * `min(availableCents, monthlyLimit + carryover - currentMonthUsed)` ab.
 * Cost-Estimate, Consumption-Engine-Vorab-Check und Frontend nutzen dieses
 * Feld für §45b — Anzeige und Buchung können nicht mehr drift.
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

describe("Task #423 — §45b Monats-Cap: Anzeige == Buchung", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    // Setup analog zu Mentke (Kunde 182):
    //   - Topf-Startwert 393 € (initial_balance)
    //   - aber Monats-Cap nur 131 €
    //   - ein dokumentierter Termin im aktuellen Monat verbraucht
    //     bereits den Großteil des Caps
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T423-CAP",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        // Cap = 5000 ct (50 €), Pott = 50000 ct (500 €) — Cap < Pott garantiert.
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 5000 },
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
          // 60 min Hauswirtschaft (PG2 default 3800 ct/h) → 3800 ct verbraucht
          // im aktuellen Monat. currentMonthAvailable = 5000 - 3800 = 1200 ct.
          date: weekdayInCurrentMonth(),
          scheduledStart: "09:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "T423 Cap-Verbrauch im aktuellen Monat",
        },
      ],
    });
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("Overview liefert currentMonthAvailableCents < availableCents wenn Cap greift", async () => {
    const res = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(res.status).toBe(200);
    const s45b = res.data.entlastungsbetrag45b;

    expect(s45b).toHaveProperty("currentMonthAvailableCents");
    expect(s45b.monthlyLimitCents).toBe(5000);
    expect(s45b.currentMonthUsedCents).toBeGreaterThan(0);

    // availableCents = Topf-Rest (annual) — sollte deutlich > Cap-Rest sein
    expect(s45b.availableCents).toBeGreaterThan(s45b.currentMonthAvailableCents);
    // Cap-Rest = 5000 - currentMonthUsed
    expect(s45b.currentMonthAvailableCents).toBe(
      Math.max(0, s45b.monthlyLimitCents + s45b.carryoverCents - s45b.currentMonthUsedCents)
    );
  });

  it("Cost-Estimate für teuren Termin blockt mit Cap-spezifischer Warnung (statt zu täuschen)", async () => {
    // 60 min HW kostet ~3800 ct, Cap-Rest nur ~1200 ct → Hard-Block erwartet,
    // weil acceptsPrivatePayment=false. Vor dem Fix wurde availableCents
    // (Topf-Rest, viele tausend ct) gemeldet → KEIN Block, irreführend.
    const today = getTodayDate();
    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.totalCents).toBeGreaterThan(0);
    expect(res.data.isHardBlock).toBe(true);
    expect(res.data.warning).toContain("Monats-Cap §45b");
    // Das im Cost-Estimate ausgewiesene "verfügbar" muss dem Cap-Rest
    // entsprechen, nicht dem (großen) Topf-Rest.
    expect(res.data.availableCents).toBeLessThan(res.data.totalCents);
  });

  it("Cost-Estimate für Folgemonat unterdrückt Cap-Hard-Block (Cap betrifft nur aktuellen Monat)", async () => {
    // Aktueller Monats-Cap ist mit dem gebuchten Termin nahezu erschöpft
    // (Cap-Rest ~1200 ct). Eine Anfrage für einen Termin im NÄCHSTEN Monat
    // darf NICHT als Hard-Block zurückkommen — der Cap bezieht sich auf den
    // jeweiligen Termin-Monat, im Folgemonat ist noch kein Verbrauch da.
    const next = new Date();
    next.setDate(15);
    next.setMonth(next.getMonth() + 1);
    const nextMonthDate = next.toISOString().slice(0, 10);

    const res = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${nextMonthDate}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );
    expect(res.status).toBe(200);
    expect(res.data.totalCents).toBeGreaterThan(0);
    // Cap = 5000 ct, 60min HW kostet ~3800 ct → passt in den Folgemonats-Cap.
    expect(res.data.isHardBlock).toBe(false);
    // Warning darf KEINEN Cap-Hinweis enthalten (oder gar kein Warning).
    if (res.data.warning) {
      expect(res.data.warning).not.toContain("Monats-Cap");
    }
  });

  it("Consumption-Engine-Vorab-Check verwendet denselben Cap-Wert", async () => {
    // Indirekter Nachweis: weil cost-estimate jetzt isHardBlock=true zurückgibt,
    // würde die UI das Speichern/Dokumentieren bereits unterbinden. Die
    // tatsächliche Engine prüft mit demselben currentMonthAvailableCents
    // (siehe consumption-engine.ts), so dass auch ein API-Direktaufruf den
    // Block sieht. Das wird in budget-e2e.test.ts INT-13.x für allgemeine
    // Cap-Verbrauchssemantik abgedeckt; hier sichern wir nur die
    // Konsistenz-Invariante zwischen Anzeige und Engine zu.
    const overview = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    const today = getTodayDate();
    const estimate = await apiGet<any>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${today}` +
      `&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`
    );

    const s45b = overview.data.entlastungsbetrag45b;
    // Cost-Estimate "available" für §45b-only-Setup == currentMonthAvailableCents
    expect(estimate.data.availableCents).toBe(s45b.currentMonthAvailableCents);
  });
});
