import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { readBudget45bFifoBreakdown } from "../../server/storage/budget/fifo-breakdown";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

/**
 * Die FIFO-Aufschlüsselung sieht dieselbe Verbrauchs-Menge wie der Reader.
 * (Ticket `6hcVM394XgmP37GG`, gemessen am 24.09.2026.)
 *
 * ── Der Fehler ──────────────────────────────────────────────────────────
 * `consumedCur = C − consumedCarry` zieht zwei Zahlen voneinander ab:
 *   · `C` kommt aus dem Reader und ist um den Reset-Schnitt bereinigt
 *   · `consumedCarry` kam aus einer Pro-Allocation-Rechnung **ohne** jeden
 *     Schnitt — nicht einmal `transactionDate <= asOfDate`
 *
 * Ein Verbrauch vor dem Stichtag fiel damit aus `C` heraus, blieb in
 * `consumedCarry` stehen, und die Differenz wurde **negativ**.
 *
 * ── Warum das nach OBEN falsch ist ──────────────────────────────────────
 * Ein negativer Verbrauch senkt nichts — er **erhöht** den ausgewiesenen Rest.
 * Der Client filtert Töpfe über `allocatedCents > 0`; ein negativer *Verbrauch*
 * fällt dabei nicht auf. Die Zahl ist also zu hoch, und zwar in der Richtung,
 * in der gebucht wird.
 *
 * Derselbe Mechanismus wie bei #180 (`allocatedCur` kippte auf −1.048,00 €),
 * nur auf der Verbrauchs- statt der Anspruchsseite.
 */

const J = 2026;
const UEBERTRAG = 500_00;
const STARTWERT = 300_00;
const VOR_STICHTAG = 100_00;   // gegen die Übertragszeile gebucht
const OHNE_ZUORDNUNG = 50_00;

async function kundeMitLage(): Promise<{ id: number; uebertragId: number }> {
  await getAuthCookie();
  const id = (await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  })).id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${J - 2}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${J}-01-01`, validTo: null,
  });
  const [ue] = await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
    amountCents: UEBERTRAG, source: "carryover",
    validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "FS-uebertrag",
  }).returning({ id: budgetAllocations.id });

  await db.insert(budgetTransactions).values([
    {
      customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
      amountCents: -VOR_STICHTAG, transactionDate: `${J}-01-20`,
      allocationId: ue.id, description: "FS-jan-gegen-uebertrag",
    },
    {
      customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
      amountCents: -OHNE_ZUORDNUNG, transactionDate: `${J}-02-20`,
      allocationId: null, description: "FS-feb-ohne-zuordnung",
    },
  ] as never);

  // Der Startwert setzt den Stichtag auf den 01.03. — beide Buchungen liegen davor.
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
    amountCents: STARTWERT, source: "initial_balance",
    validFrom: `${J}-03-01`, expiresAt: null, notes: "FS-startwert",
  });
  return { id, uebertragId: ue.id };
}

describe("§45b-FIFO — der Stichtags-Schnitt gilt für beide Töpfe", () => {
  it("FS-1 – kein Topf meldet negativen Verbrauch", async () => {
    const { id } = await kundeMitLage();
    try {
      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      for (const topf of fifo.pots) {
        expect(
          topf.consumedCents,
          `Topf „${topf.potType}" meldet negativen Verbrauch (${topf.consumedCents}) — `
          + "das erhöht den ausgewiesenen Rest",
        ).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("FS-2 – die Summe der Töpfe stimmt mit dem Reader überein", async () => {
    /**
     * Die eigentliche Zusage. `FS-1` allein wäre auch erfüllt, wenn der
     * Verbrauch irgendwo bei 0 abgeschnitten würde — dann wäre die Zahl nicht
     * mehr negativ, aber immer noch falsch.
     */
    const { id } = await kundeMitLage();
    try {
      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const uni = await readUnifiedBudgetAvailability(id, `${J}-05-15`);
      const topf = uni.pots.entlastungsbetrag_45b;

      const summeVerbrauch = fifo.pots.reduce((n, p) => n + p.consumedCents, 0);
      expect(
        summeVerbrauch,
        "FIFO und Reader sehen verschiedene Verbrauchs-Mengen — genau die "
        + "Differenz, aus der der negative Topf entsteht",
      ).toBe(topf.consumedNetCents);

      const summeAlloc = fifo.pots.reduce((n, p) => n + p.allocatedCents, 0);
      expect(summeAlloc, "auch der Anspruch läuft auseinander").toBe(topf.allocatedCents);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("FS-3 – konkrete Zahlen, damit die Zusage nicht nur eine Gleichung ist", async () => {
    /**
     * Ohne feste Zahlen wäre `FS-2` auch erfüllt, wenn beide Seiten dasselbe
     * Falsche liefern. Gerechnet: der Stichtag 01.03. schneidet BEIDE
     * Buchungen weg (20.01. und 20.02. liegen davor), der Verbrauch ist also 0.
     *
     * Anspruch zum 15.05.: Übertrag 500 (nicht verdrängt, Flag aus)
     *   + Startwert 300 (März) + 2 × 131 (April, Mai) = 1.062,00 €
     */
    const { id } = await kundeMitLage();
    try {
      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      const cur = fifo.pots.find(p => p.potType === "current_year")!;

      expect(carry.consumedCents, "der Januar-Verbrauch wird nicht geschnitten").toBe(0);
      expect(cur.consumedCents, "der current_year-Topf trägt einen Rest-Verbrauch").toBe(0);
      expect(carry.allocatedCents).toBe(UEBERTRAG);
      expect(cur.allocatedCents, "Startwert 300 + 2 × 131").toBe(300_00 + 2 * 131_00);
      expect(cur.remainingCents, "der Rest ist zu hoch — der alte Fehler ist zurück")
        .toBe(300_00 + 2 * 131_00);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("FS-4 – ein Verbrauch NACH dem Stichtag zählt weiterhin", async () => {
    /**
     * Die Gegenrichtung. Ohne sie wäre der Fix auch erfüllt, wenn die
     * Pro-Allocation-Rechnung gar keinen Verbrauch mehr sieht — dann wäre der
     * Übertrags-Topf immer voll, und das wäre derselbe Fehler nach oben.
     */
    const { id, uebertragId } = await kundeMitLage();
    try {
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -80_00, transactionDate: `${J}-04-10`,
        allocationId: uebertragId, description: "FS-apr-nach-stichtag",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      expect(
        carry.consumedCents,
        "der April-Verbrauch nach dem Stichtag wurde mit weggeschnitten",
      ).toBe(80_00);
      expect(carry.remainingCents).toBe(UEBERTRAG - 80_00);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
  it("FS-5 – eine Buchung NACH dem Stichtag zählt nicht mit", async () => {
    /**
     * Das zweite Glied des Prädikats: `transactionDate <= asOfDate`.
     *
     * Die Pro-Allocation-Rechnung hatte es vorher ebenfalls nicht — eine
     * Buchung in der Zukunft belastete den Übertrags-Topf rückwirkend in jeder
     * Stichtagssicht. Der Mutations-Gegencheck hat die Lücke aufgedeckt: das
     * Entfernen des `as-of` ließ FS-1..FS-4 grün.
     */
    const { id, uebertragId } = await kundeMitLage();
    try {
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -200_00, transactionDate: `${J}-06-20`,
        allocationId: uebertragId, description: "FS-juni-nach-stichtag",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      expect(
        carry.consumedCents,
        "eine Buchung nach dem Stichtag belastet den Topf rückwirkend",
      ).toBe(0);
      expect(carry.remainingCents).toBe(UEBERTRAG);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
