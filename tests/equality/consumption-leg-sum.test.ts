/**
 * Task #441 — Equality: Σ Leg-Spalten == |amountCents| pro Konsum-Transaktion.
 *
 * Hintergrund: `buildConsumptionTxData` skaliert die vier Bein-Posten
 * (hauswirtschaftCents, alltagsbegleitungCents, travelCents,
 *  customerKilometersCents) per Ratio aus den Cost-Estimates. Vor #441
 * wurde jeder Posten unabhängig auf Cents gerundet, sodass `Σlegs` in
 * Cascade-Splits / Cap-Limit-Szenarien um bis zu 1 Cent pro Bein vom
 * gebuchten `amountCents` driften konnte. Lexware-Export, Statistiken
 * und §45b-Anzeigen summieren die Bein-Spalten und erwarten exakt den
 * Buchungsbetrag.
 *
 * Subtract-Last-Fix: Der letzte gesetzte Bein-Posten (ck > tv > ab > hw)
 * wird als Residuum gesetzt → `Σlegs === |amountCents|`.
 *
 * Dieser Test bucht über die ECHTE Engine (`bookConsumption` →
 * `createConsumptionTransaction`) und prüft den Invariant in allen
 * relevanten Cascade-Pfaden:
 *   - Single-Topf, Cost = Available (klassisch)
 *   - Single-Topf, Cost > Available (Cap-/Pot-Limit → Ratio < 1)
 *   - Privatzahlung-Leg (separater Tx mit kompletten Bein-Posten)
 */
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
import { budgetTransactions } from "@shared/schema";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function getConsumptionAndPrivateTxs(appointmentId: number) {
  return db
    .select({
      id: budgetTransactions.id,
      type: budgetTransactions.transactionType,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
      hwCents: budgetTransactions.hauswirtschaftCents,
      abCents: budgetTransactions.alltagsbegleitungCents,
      tvCents: budgetTransactions.travelCents,
      ckCents: budgetTransactions.customerKilometersCents,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, appointmentId));
}

describe("Equality Σ Leg-Spalten == |amountCents| (Task #441 Subtract-Last)", () => {
  it("Standard-Buchung: pro Konsum-Tx mit Bein-Daten gilt Σlegs == |amountCents|", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T441-LEG",
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
        hwMinutes: 47,
        abMinutes: 31,
        travelKm: 7.3,
        customerKm: 2.4,
        userId: auth.user.id,
      });

      const txs = await getConsumptionAndPrivateTxs(booked.appointmentId);
      expect(txs.length).toBeGreaterThan(0);

      for (const tx of txs) {
        // Nur Konsum-Buchungen (consumption / private) prüfen — Reversal/Adj
        // schreiben keine Leg-Spalten.
        if (tx.type !== "consumption") continue;
        // Bein-Spalten sind nur in der ersten Cascade-Tx und in der Privat-Tx
        // gesetzt — leere Folge-Töpfe (alle null) sind kein Drift-Treffer.
        const hasAnyLeg = [tx.hwCents, tx.abCents, tx.tvCents, tx.ckCents].some(v => v != null);
        if (!hasAnyLeg) continue;
        const legSum = (tx.hwCents ?? 0) + (tx.abCents ?? 0) + (tx.tvCents ?? 0) + (tx.ckCents ?? 0);
        expect(
          legSum,
          `Tx #${tx.id} (${tx.budgetType}, type=${tx.type}): ` +
          `Σlegs=${legSum} ≠ |amountCents|=${Math.abs(tx.amountCents)} ` +
          `(hw=${tx.hwCents}, ab=${tx.abCents}, tv=${tx.tvCents}, ck=${tx.ckCents})`,
        ).toBe(Math.abs(tx.amountCents));
      }
    } finally {
      await scenario.cleanup();
    }
  });

  it("Cascade-Overflow: §45b ausgeschöpft → Privatzahlung-Tx erfüllt Σlegs == |amountCents|", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    // Sehr kleines Budget → garantiert Privatzahlung-Overflow.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T441-OVL",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      preferences: { budgetStartDate: "2024-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 137, validFrom: "2024-01-01" },
    });
    try {
      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes: 60,
        abMinutes: 30,
        travelKm: 3.7,
        customerKm: 1.9,
        userId: auth.user.id,
      });

      const txs = await getConsumptionAndPrivateTxs(booked.appointmentId);
      const consumptionLike = txs.filter(t => t.type === "consumption");
      // Wir erwarten mindestens zwei Konsum-Töpfe: §45b (Teilbuchung) + private (Rest).
      const withLegs = consumptionLike.filter(t =>
        [t.hwCents, t.abCents, t.tvCents, t.ckCents].some(v => v != null),
      );
      expect(withLegs.length).toBeGreaterThanOrEqual(1);

      for (const tx of withLegs) {
        const legSum = (tx.hwCents ?? 0) + (tx.abCents ?? 0) + (tx.tvCents ?? 0) + (tx.ckCents ?? 0);
        expect(
          legSum,
          `Overflow-Tx #${tx.id} (${tx.budgetType}): ` +
          `Σlegs=${legSum} ≠ |amountCents|=${Math.abs(tx.amountCents)} ` +
          `(hw=${tx.hwCents}, ab=${tx.abCents}, tv=${tx.tvCents}, ck=${tx.ckCents})`,
        ).toBe(Math.abs(tx.amountCents));
      }
    } finally {
      await scenario.cleanup();
    }
  });
});
