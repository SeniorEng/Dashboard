/**
 * Task #1129 — Konsistenz der §45b FIFO-Aufschlüsselung.
 *
 * Die read-only FIFO-Visualisierung (`GET /api/budget/:id/fifo-breakdown`)
 * darf KEINE eigene Verfügbarkeits-Mathematik betreiben. Sie verteilt die
 * Summen des EINEN unified Readers nur FIFO-konform auf zwei Töpfe (Übertrag →
 * laufendes Jahr) und klassifiziert den Konsum nach Termin-Zustand.
 *
 * Dieser Test sichert die Invariante ab, dass die Topf-Summen EXAKT mit den
 * §45b-Kartenzahlen aus der Overview rekonzilieren:
 *   Σ allocated  === overview.totalAllocatedCents
 *   Σ consumed   === overview.totalUsedCents   (kein manual_adjustment im Setup)
 *   Σ remaining  === overview.availableCents
 * sowie die Pro-Topf-Identitäten
 *   allocated === consumed + planned + remaining
 *   consumed  === billed + documented + other
 *
 * Bewusst OHNE manual_adjustment-Szenarien (würde die bekannte §45b-Schatten-
 * Drift zwischen consumedNet und Karten-totalUsed triggern, Phase-6-Thema).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthCookie, apiGet, runCleanup } from "../test-utils";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import type { BudgetFifo45bBreakdownDTO } from "@shared/api/budget";

const ORIGINAL_TZ = process.env.TZ;

interface OverviewDTO {
  entlastungsbetrag45b: {
    totalAllocatedCents: number;
    totalUsedCents: number;
    availableCents: number;
  };
}

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("Task #1129 — §45b FIFO-Aufschlüsselung rekonziliert exakt mit der Overview-Karte", () => {
  let handle: BudgetScenarioHandle | null = null;

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it("Übertrag + laufendes Jahr + dokumentierte Termine: Topf-Summen === Karten-Zahlen", async () => {
    // Ein einziger Datums-Anker; alle abgeleiteten Daten hängen daran.
    const now = new Date();
    const year = now.getFullYear();
    const sourceYear = year - 1;
    // Termin-Anker: 1. des laufenden Monats (immer in der Vergangenheit/Gegenwart
    // gegenüber „heute", damit der Konsum den asOfDate-Filter passiert).
    const apptMonth = String(now.getMonth() + 1).padStart(2, "0");
    const apptDate = `${year}-${apptMonth}-01`;
    const asOfDate = apptDate;

    handle = await setupBudgetScenario({
      customerNamePrefix: "T1129-FIFO",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      ],
      // Übertrag aus dem Vorjahr + Startwert im laufenden Jahr → zwei Töpfe.
      carryover: { type: "entlastungsbetrag_45b", amountCents: 20_000, year: sourceYear },
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 13_100, validFrom: `${year}-01-01` },
      appointments: [
        {
          date: apptDate,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
      ],
    });

    const [overviewRes, fifoRes] = await Promise.all([
      apiGet<OverviewDTO>(`/api/budget/${handle.customerId}/overview?date=${asOfDate}`),
      apiGet<BudgetFifo45bBreakdownDTO>(`/api/budget/${handle.customerId}/fifo-breakdown?date=${asOfDate}`),
    ]);

    expect(overviewRes.status).toBe(200);
    expect(fifoRes.status).toBe(200);

    const card = overviewRes.data.entlastungsbetrag45b;
    const fifo = fifoRes.data;

    // Reconciliation-Felder == Karte.
    expect(fifo.totalAllocatedCents).toBe(card.totalAllocatedCents);
    expect(fifo.totalConsumedCents).toBe(card.totalUsedCents);
    expect(fifo.totalAvailableCents).toBe(card.availableCents);

    // Σ über beide Töpfe == Karten-Zahlen (der Kern der Anforderung).
    const sum = (key: keyof BudgetFifo45bBreakdownDTO["pots"][number]) =>
      fifo.pots.reduce((s, p) => s + (p[key] as number), 0);
    expect(sum("allocatedCents")).toBe(card.totalAllocatedCents);
    expect(sum("consumedCents")).toBe(card.totalUsedCents);
    expect(sum("remainingCents")).toBe(card.availableCents);

    // Pro-Topf-Identitäten.
    for (const pot of fifo.pots) {
      expect(pot.allocatedCents).toBe(pot.consumedCents + pot.plannedCents + pot.remainingCents);
      expect(pot.consumedCents).toBe(
        pot.consumedBilledCents + pot.consumedDocumentedCents + pot.consumedOtherCents,
      );
    }

    // FIFO-Reihenfolge: genau zwei Töpfe, Übertrag zuerst.
    expect(fifo.pots.map((p) => p.potType)).toEqual(["carryover", "current_year"]);

    // Übertrag im H1 des Jahres noch gültig (expiresAt = 30.06.) ⇒ Verfallsdatum
    // gesetzt, sofern der Übertrags-Topf eine Allokation trägt.
    const carry = fifo.pots.find((p) => p.potType === "carryover");
    if (carry && carry.allocatedCents > 0) {
      expect(fifo.carryoverExpiresAt).not.toBeNull();
    }
  });
});
