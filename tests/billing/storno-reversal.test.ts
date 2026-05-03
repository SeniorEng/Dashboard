/**
 * Phase-2 Bug-Tests — K2: Storno mit Budget-Reversal
 *
 * Heute storniert PATCH /api/billing/:id/status mit status=storniert nur
 * die Rechnung (erzeugt Stornorechnung) und buert KEINE Budget-Transaktionen
 * zurück. Das §45b-Overview behält damit currentMonthUsedCents auch nach
 * dem Storno auf dem alten Verbrauchsstand.
 *
 * Erwartet (Phase-2): Storno reversiert die zugehörigen Budget-Transaktionen,
 * sodass der §45b-Topf den aktuellen Monatsverbrauch auf 0 zurückzieht und
 * der volle Cap als availableCents bereitsteht.
 *
 * Mapping: Test → K-Punkt → Fix-Status
 *   K2 → it.fails (heute kein Auto-Reversal, kippt nach Storno-Reversal-Fix)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";

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

let scenario: BudgetScenarioHandle;
const cleanupSrIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
  const apptDate = weekdayInCurrentMonth();
  scenario = await setupBudgetScenario({
    customerNamePrefix: "K2Storno",
    pflegegrad: 3,
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
    appointments: [
      {
        date: apptDate,
        scheduledStart: "01:00",
        services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
        document: true,
        actualStart: "01:00",
      },
    ],
  });
});

afterAll(async () => {
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  await scenario.cleanup();
  await runCleanup();
});

describe("K2 — Storno reversiert §45b-Budget-Transaktionen", () => {
  it.fails("K2.1 — Nach Storno zeigt §45b currentMonthUsedCents = 0", async () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const auth = await getAuthCookie();

    // LN für aktuellen Monat erzeugen + signieren.
    const srRes = await apiPost<any>("/api/service-records", {
      customerId: scenario.customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${srRes.data.id}/sign`, {
        signerType,
        signatureData: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // Rechnung generieren.
    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId: scenario.customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invoices: any[] = genRes.data?.splitInvoices ? genRes.data.invoices
      : Array.isArray(genRes.data) ? genRes.data
      : [genRes.data];
    const kasseInv = invoices.find((i: any) => i.billingType === "pflegekasse_privat") || invoices[0];
    expect(kasseInv?.id, "Kassen-/Hauptrechnung muss erzeugt sein").toBeDefined();

    // Snapshot vor Storno: §45b ist verbraucht.
    const beforeRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(beforeRes.status).toBe(200);
    const before45b = beforeRes.data.entlastungsbetrag45b;
    expect(before45b.currentMonthUsedCents, "Vor Storno muss §45b Verbrauch > 0 sein").toBeGreaterThan(0);

    // Storno.
    const stornoRes = await apiPatch<any>(`/api/billing/${kasseInv.id}/status`, { status: "storniert" });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    // Nach Storno (Phase-2 Erwartung): Budget zurückgebucht.
    const afterRes = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(afterRes.status).toBe(200);
    const after45b = afterRes.data.entlastungsbetrag45b;

    expect(
      after45b.currentMonthUsedCents,
      `K2-Bug: Storno hat §45b nicht zurückgebucht. before=${before45b.currentMonthUsedCents}, after=${after45b.currentMonthUsedCents}`,
    ).toBe(0);
    expect(
      after45b.availableCents,
      "Nach Storno muss verfügbarer §45b-Betrag ≥ vor Storno sein",
    ).toBeGreaterThanOrEqual(before45b.availableCents);
  });
});
