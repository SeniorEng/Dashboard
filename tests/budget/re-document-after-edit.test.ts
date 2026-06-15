/**
 * Task #636 — Re-Document nach Reopen+Edit darf keine Duplicate-Warning erzeugen.
 *
 * Hintergrund: PATCH-Pfad rebookt die Consumption für die appointmentId
 * (Task #613/#618). Das anschließende POST /api/appointments/:id/document
 * würde sonst nochmal `createConsumptionTransaction` aufrufen, in den
 * Duplicate-Check der Cascade-Engine laufen und eine kosmetische
 * `budgetWarning` setzen. Der Route-Handler erkennt jetzt eine bestehende
 * aktive Consumption und überspringt den Buchungsversuch.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { quarantinedInCI } from "../helpers/known-failing";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { apiGet, apiPatch, apiPost, getAuthCookie } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";

function pastWeekdayInCurrentMonth(): string {
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

async function selectActiveConsumptionTxs(
  customerId: number,
  appointmentId: number,
) {
  return db
    .select()
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    )
    .orderBy(asc(budgetTransactions.id));
}

describe("Task #636 — Re-Document nach Reopen+Edit", () => {
  let scenario: BudgetScenarioHandle;

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterEach(async () => {
    if (scenario) {
      await scenario.cleanup();
    }
  });

  it.skipIf(quarantinedInCI)("Re-Document nach Reopen+km-PATCH löst KEINE budgetWarning aus und legt keine zweite aktive Consumption an", async () => {
    const date = pastWeekdayInCurrentMonth();
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T636-REDOC",
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
          document: true,
          travelKilometers: 10,
          customerKilometers: 0,
          notes: "T636 initial km=10",
        },
      ],
    });

    const [appointmentId] = scenario.appointmentIds;
    const customerId = scenario.customerId;

    // Reopen → Status auf documenting; PATCH-km triggert km-Rebook
    // (Task #613) und legt eine neue aktive Consumption mit km=20 an.
    const reopenRes = await apiPost<{ status: string }>(
      `/api/appointments/${appointmentId}/reopen`,
      {},
    );
    expect(reopenRes.status).toBe(200);

    const patchRes = await apiPatch<{ id: number; travelKilometers: number }>(
      `/api/appointments/${appointmentId}`,
      { travelKilometers: 20 },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.travelKilometers).toBe(20);

    const afterPatch = await selectActiveConsumptionTxs(customerId, appointmentId);
    expect(afterPatch.length).toBeGreaterThan(0);
    const patchTxIds = new Set(afterPatch.map((t) => t.id));

    // Re-Document mit den gleichen Werten → darf keine Warning erzeugen
    // und keine zusätzliche aktive Consumption anlegen.
    const svcRes = await apiGet<Array<{ serviceId: number }>>(
      `/api/appointments/${appointmentId}/services`,
    );
    expect(svcRes.status).toBe(200);
    const services = svcRes.data.map((s) => ({
      serviceId: s.serviceId,
      actualDurationMinutes: 60,
      details: "T636 re-document",
    }));

    const reDocRes = await apiPost<{
      status: string;
      budgetWarning: string | null;
      budgetTransaction: { id: number } | null;
    }>(
      `/api/appointments/${appointmentId}/document`,
      {
        actualStart: "08:00",
        travelOriginType: "home",
        travelKilometers: 20,
        customerKilometers: 0,
        services,
      },
    );
    expect(reDocRes.status).toBe(200);
    expect(reDocRes.data.budgetWarning).toBeNull();
    expect(reDocRes.data.status).toBe("completed");
    expect(reDocRes.data.budgetTransaction).not.toBeNull();
    // Die zurückgelieferte budgetTransaction ist die bereits vom Rebook
    // angelegte aktive Consumption — kein Neu-Insert durch den Re-Document-
    // Pfad.
    expect(patchTxIds.has(reDocRes.data.budgetTransaction!.id)).toBe(true);

    const afterRedoc = await selectActiveConsumptionTxs(customerId, appointmentId);
    expect(afterRedoc.map((t) => t.id).sort()).toEqual(
      afterPatch.map((t) => t.id).sort(),
    );
  });
});
