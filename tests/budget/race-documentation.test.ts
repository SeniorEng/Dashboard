import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  apiGet,
  apiPost,
  apiPut,
  getAuthCookie,
} from "../test-utils";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { runInParallel } from "../helpers/race";
import { thawTime } from "../helpers/frozen-clock";

interface CostEstimateResponse {
  totalCents: number;
}

interface DocumentResponse {
  budgetTransaction: {
    id: number;
    budgetType: string;
    amountCents: number;
  } | null;
}

function pastWeekdayInCurrentMonth(): string {
  // Beide Termine müssen im SELBEN Monat liegen, damit der monatliche
  // §45b-Cap auf BEIDE Buchungen wirkt (cap-calculator rechnet pro
  // Kalendermonat). Wir picken den jüngsten vergangenen Werktag im
  // aktuellen Monat; falls keiner existiert, weichen wir vorwärts aus.
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

describe("Race K4 — parallele Dokumentation auf knappes §45b-Restbudget", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
    thawTime();
  });

  it("RACE-K4 — Zwei parallele /document-Calls überbuchen niemals den §45b-Topf (Advisory-Lock greift)", async () => {
    // Schritt 1: Szenario mit großzügigem Cap anlegen, damit die
    // cost-estimate-API einen sauberen Wert liefert. Anschließend wird der
    // Cap exakt auf die Kosten EINER Buchung gesetzt — so reicht das §45b-
    // Restbudget genau für einen der beiden parallelen Calls.
    const date1 = pastWeekdayInCurrentMonth();
    const date2 = date1;
    // Budget-Start auf den ersten Tag des aktuellen Monats setzen, damit keine
    // §45b-Carryover-Töpfe aus Vorjahren entstehen (Carryover wird in der
    // cap-Berechnung als `effectiveLimit = monthlyLimitCents + carryoverCents`
    // addiert und würde unseren Cap aushebeln).
    const today = new Date();
    const budgetStartDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;

    scenario = await setupBudgetScenario({
      customerNamePrefix: "RACE-K4",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      preferences: { budgetStartDate },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 100000 },
        { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
      ],
      appointments: [
        {
          date: date1,
          scheduledStart: "08:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          notes: "RACE-K4 Slot A",
        },
        {
          date: date2,
          scheduledStart: "09:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          notes: "RACE-K4 Slot B",
        },
      ],
    });

    expect(scenario.appointmentIds).toHaveLength(2);
    const [apptId1, apptId2] = scenario.appointmentIds;

    // Exakte Kosten für 60 Min Hauswirtschaft am Termindatum bestimmen.
    const estRes = await apiGet<CostEstimateResponse>(
      `/api/budget/${scenario.customerId}/cost-estimate?date=${date1}&hauswirtschaftMinutes=60&alltagsbegleitungMinutes=0&travelKilometers=0&customerKilometers=0`,
    );
    expect(estRes.status).toBe(200);
    const costPerAppt = estRes.data.totalCents;
    expect(costPerAppt).toBeGreaterThan(0);

    // Cap exakt = Kosten EINER Buchung. Restbudget reicht so nur für genau
    // einen der beiden parallelen Calls; der Verlierer muss den Überlauf
    // privat verbuchen.
    const capRes = await apiPut<unknown>(
      `/api/budget/${scenario.customerId}/type-settings`,
      {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: costPerAppt, yearlyLimitCents: null, validFrom: null, validTo: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        ],
      },
    );
    expect(capRes.status).toBe(200);

    const servicesRes = await apiGet<Array<{ id: number; code: string }>>(
      "/api/services",
    );
    expect(servicesRes.status).toBe(200);
    const hwService = servicesRes.data.find((s) => s.code === "hauswirtschaft");
    expect(hwService).toBeDefined();
    const serviceId = hwService!.id;

    const buildDocPayload = () => ({
      actualStart: "08:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [
        { serviceId, actualDurationMinutes: 60, details: "RACE-K4 doc" },
      ],
    });

    // Echte Race: beide Calls werden in derselben Mikrotask gestartet. Ohne
    // den Advisory-Lock aus consumption-engine.ts würden beide den vollen
    // §45b-Topf konsumieren (Doppel-Konsum bis 2 × cap).
    const results = await runInParallel<{
      status: number;
      data: DocumentResponse;
    }>([
      () => apiPost<DocumentResponse>(`/api/appointments/${apptId1}/document`, buildDocPayload()),
      () => apiPost<DocumentResponse>(`/api/appointments/${apptId2}/document`, buildDocPayload()),
    ]);

    // Beide Calls dürfen erfolgreich sein, weil acceptsPrivatePayment=true
    // den Überlauf als private-Verbrauch verbucht. Wichtig: Lock darf nicht
    // zu Hard-Fails führen.
    const settledStatuses = results.map((r) =>
      r.status === "fulfilled" ? r.value.status : "rejected",
    );
    for (const s of settledStatuses) {
      expect(s).toBe(200);
    }

    // Wahrheit aus der DB: §45b-Verbrauch summiert (consumption + write_off,
    // Reversals abgezogen) darf das Cap niemals überschreiten.
    const consumedRow = await db
      .select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.customerId, scenario.customerId),
          eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
          eq(budgetTransactions.transactionType, "consumption"),
        ),
      );
    const total45bConsumed = Number(consumedRow[0]?.total ?? 0);
    expect(total45bConsumed).toBeLessThanOrEqual(costPerAppt);

    // Genau eine der beiden Buchungen wurde aus §45b bezahlt.
    expect(total45bConsumed).toBe(costPerAppt);

    // Der Überlauf der zweiten Buchung wurde als private Konsum verbucht.
    const privateRow = await db
      .select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
      .from(budgetTransactions)
      .where(
        and(
          eq(budgetTransactions.customerId, scenario.customerId),
          eq(budgetTransactions.budgetType, "private"),
          eq(budgetTransactions.transactionType, "consumption"),
        ),
      );
    const totalPrivate = Number(privateRow[0]?.total ?? 0);
    expect(totalPrivate).toBeGreaterThan(0);
    expect(totalPrivate).toBe(costPerAppt);

    // Sicherstellen, dass nicht beide Termine vollständig aus Budget verbucht
    // wurden — also der Topf nie über das Cap hinaus genutzt wurde.
    expect(total45bConsumed).toBeLessThan(2 * costPerAppt);
  });
});
