/**
 * Task #727 — Equality §45b: BudgetHistoryView monatliche Aggregate ===
 * BudgetOverviewView (`getBudgetSummary.totalUsedCents`).
 *
 * Phase 1.3 der Budget-SSoT-Konsolidierung. Sichert ab, dass die
 * History-Sicht keine eigene Topf-Mathematik nachbaut, sondern dieselbe
 * Allocation-Sicht-Formel verwendet wie der Overview-Snapshot
 * (`consumption + write_off + manual_adjustment − reversal`).
 *
 * Random-Customer-Setup: §45b mit Initial-Balance im laufenden Monat,
 * 2 dokumentierten Terminen, 1 Reversal und 1 Manual-Adjustment. Wenn
 * die Sicht-Formeln driften, schlägt der Test mit der konkreten Differenz
 * fehl.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { apiGet, apiPost, getAuthCookie, runCleanup } from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import type { MonthlyHistoryBucket } from "@shared/domain/budget/history-aggregation";
import { sumAllocationView } from "@shared/domain/budget/history-aggregation";

interface OverviewResponse {
  entlastungsbetrag45b: {
    totalUsedCents: number;
    totalAllocatedCents: number;
  };
}

interface HistoryResponse {
  buckets: MonthlyHistoryBucket[];
}

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Equality — BudgetHistoryView monatlich === BudgetOverview Snapshot (Phase 1.3)", () => {
  it("§45b: SUM(monatlich netUsedAllocationCents) === overview.totalUsedCents", async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const firstOfMonth = `${ym}-01`;
    // Termine in der nahen Zukunft, damit weder Monatsabschluss-Cutoff noch
    // Überlapp-Schutz (gleiche Test-Run-Daten) triggern. Wir greifen 1 und 2
    // Tage in die Zukunft; bleibt sicher im laufenden Monat, weil der
    // Scheduler-Cutoff erst am 8. des Folgemonats läuft.
    // Suche die nächsten beiden Werktage (Mo–Fr) ab heute, damit die
    // Appointment-Policy (Weekend-Block für Nicht-Superadmin) nicht greift.
    const nextWeekdays: Date[] = [];
    for (let i = 1; nextWeekdays.length < 2 && i < 14; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) nextWeekdays.push(d);
    }
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day1 = fmt(nextWeekdays[0]);
    const day2 = fmt(nextWeekdays[1]);

    const scenario: BudgetScenarioHandle = await setupBudgetScenario({
      customerNamePrefix: "T727-HIST",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: firstOfMonth },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: firstOfMonth,
      },
      appointments: [
        {
          date: day1,
          scheduledStart: "09:00:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
        },
        {
          date: day2,
          scheduledStart: "10:00:00",
          services: [{ code: "alltagsbegleitung", durationMinutes: 60 }],
          document: true,
        },
      ],
      manualAdjustments: [
        {
          type: "entlastungsbetrag_45b",
          amountCents: -500,
          notes: "T727 history equality",
        },
      ],
    });

    try {
      // Reversal: erste Termin-Buchung stornieren, damit `reversal` in beiden
      // Sichten denselben Beitrag liefert (Subtraktion in Allocation-Sicht UND
      // in Fenster-Sicht). Wenn History `reversal` falsch bucht, fliegt der
      // Test sofort raus.
      const firstTx = scenario.transactions[0];
      expect(firstTx, "Erste Termin-Buchung fehlt — Scenario-Setup bricht").toBeDefined();
      const reverseRes = await apiPost(
        `/api/budget/transactions/${firstTx.id}/reverse`,
        {},
      );
      expect([200, 201]).toContain(reverseRes.status);

      // Overview-Snapshot AS-OF dem spätesten Buchungsdatum (`day2`): seit
      // Task #911 sind die Overview-Zahlen stichtag-korrekt — `totalUsedCents`
      // zählt nur Buchungen mit `transactionDate <= asOfDate` (nötig für
      // `availableCents`-Konsistenz, da `totalAllocatedCents` ebenfalls nur bis
      // zum Stichtag aufstockt). Die Test-Termine liegen in der nahen Zukunft
      // (Cutoff-Dodge); ohne Stichtag (= heute) würden sie aus `totalUsedCents`
      // fallen, während die History-Sicht (Monats-Ledger) sie zählt. Mit
      // `?date=day2` deckt der Stichtag alle gebuchten Transaktionen ab, sodass
      // der Phase-1.3-Formel-Vertrag (gleiche Allocation-Sicht-Formel) weiterhin
      // gilt.
      const [historyRes, overviewRes] = await Promise.all([
        apiGet<HistoryResponse>(`/api/budget/${scenario.customerId}/history`),
        apiGet<OverviewResponse>(`/api/budget/${scenario.customerId}/overview?date=${day2}`),
      ]);

      expect(historyRes.status).toBe(200);
      expect(overviewRes.status).toBe(200);

      const sumHistory45b = sumAllocationView(
        historyRes.data.buckets,
        "entlastungsbetrag_45b",
      );
      const overviewUsed = overviewRes.data.entlastungsbetrag45b.totalUsedCents;

      expect(
        sumHistory45b,
        `History-Allocation-Sicht §45b = ${sumHistory45b} ct, ` +
          `Overview totalUsedCents = ${overviewUsed} ct. ` +
          `Phase 1.3-Vertrag: History.netUsedAllocationCents MUSS dieselbe ` +
          `Formel (consumption + write_off + manual_adjustment − reversal) ` +
          `wie getBudgetSummary nutzen.`,
      ).toBe(overviewUsed);

      // Strukturelle Erwartung: alle Buckets liegen im laufenden Monat
      // (das Szenario bucht ausschließlich `ym`). Drift hier würde auf
      // einen Bug im Bucket-Key hinweisen.
      const months = new Set(historyRes.data.buckets.map((b) => b.month));
      expect(months.has(ym), `Aktueller Monat ${ym} muss in History auftauchen`).toBe(true);

      // Sichts-Asymmetrie sichtbar machen: manual_adjustment zählt in der
      // Allocation-Sicht, NICHT in der Fenster-Sicht.
      const bucket45b = historyRes.data.buckets.find(
        (b) => b.month === ym && b.budgetType === "entlastungsbetrag_45b",
      );
      expect(bucket45b, "§45b-Bucket im laufenden Monat fehlt").toBeDefined();
      if (bucket45b) {
        expect(bucket45b.manualAdjustmentCents).toBeGreaterThan(0);
        expect(bucket45b.netUsedWindowCents).toBe(
          bucket45b.consumptionCents - bucket45b.reversalCents,
        );
        expect(bucket45b.netUsedAllocationCents).toBe(
          bucket45b.consumptionCents +
            bucket45b.writeOffCents +
            bucket45b.manualAdjustmentCents -
            bucket45b.reversalCents,
        );
      }
    } finally {
      await scenario.cleanup();
    }
  }, 180_000);
});
