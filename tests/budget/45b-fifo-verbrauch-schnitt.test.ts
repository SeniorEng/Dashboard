import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  appointments, budgetAllocations, budgetTransactions,
  customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
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
  /**
   * Die Uhr wird GESTELLT, statt sich auf das Kalenderjahr zu verlassen
   * (Gate 2 zu #190, S3).
   *
   * `J = 2026` allein trug nicht: `calculateAllocated45b` erdet den
   * Pflegegrad-Anker über `floorAutoAnchor45bToCurrentYear(iso, curYear)` auf
   * das ECHTE Kalenderjahr. Gemessen durch Jahres-Verschiebung (`J = 2025` bei
   * heutigem 2026 = derselbe Abstand wie `J = 2026` am 01.01.2027): **`FS-3`
   * wird rot** — genau der Test, der gegen „beide Seiten liefern dasselbe
   * Falsche" gebaut ist.
   *
   * Besonders unglücklich, weil die Begründung dieses PRs „vor dem 01.01.2027
   * Pflicht" lautet: der Regressionsschutz wäre zum selben Datum verfallen.
   *
   * Der kanonische Weg steht in `tests/helpers/billing-month.ts`: Stichtag über
   * `useTestClock` setzen, Jahreszahlen als Literale stehen lassen.
   */
  beforeEach(() => {
    useTestClock(`${J}-05-15`);
    assertTestClockActive();
  });
  afterEach(() => clearTestClock());

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
  it("FS-6 – die Zustands-Aufteilung sieht dieselbe Menge wie der Verbrauch", async () => {
    /**
     * Der Gate-2-Blocker B1. `classifyConsumedByState` trug die **dritte**
     * Fassung von „zählt diese Buchung?" — 140 Zeilen unter der zweiten, nur
     * mit `lte(transactionDate, asOfDate)`, ohne Reset-Schnitt.
     *
     * Vor diesem PR waren beide Seiten UNgeschnitten und stimmten überein. Der
     * erste Wurf des Fixes schnitt `consumedCarry` und liess die Aufteilung
     * stehen — gemessen an einem dokumentierten Termin über 100,00 € vor dem
     * Cutoff:
     *
     *     vorher (main)  verbr 100,00  dok 100,00  sonst    0,00  rest 400,00
     *     erster Wurf    verbr   0,00  dok 100,00  sonst −100,00  rest 500,00
     *     jetzt          verbr   0,00  dok   0,00  sonst    0,00  rest 500,00
     *
     * `other = consumedTotal − billed − documented` wurde negativ. Der Client
     * verschluckt Negative (`budget-45b-fifo-breakdown.tsx`: `value <= 0 →
     * null`), rendert aber die positive `documented`-Zeile — der Fehler wanderte
     * aus dem unsichtbaren in den SICHTBAREN Topf. Schlimmer als vorher.
     *
     * Deshalb prüft dieser Test alle drei Teilbeträge, nicht nur `consumedCents`.
     */
    const { id, uebertragId } = await kundeMitLage();
    try {
      const [termin] = await db.insert(appointments).values({
        customerId: id, date: `${J}-01-20`, scheduledStart: "09:00", durationPromised: 60,
        status: "completed", signatureData: "data:image/png;base64,AAA",
        appointmentType: "Betreuung",
      } as never).returning({ id: appointments.id });

      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -100_00, transactionDate: `${J}-01-20`,
        allocationId: uebertragId, appointmentId: termin.id,
        description: "FS6-dokumentiert-vor-cutoff",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;

      expect(
        carry.consumedDocumentedCents,
        "die Zustands-Aufteilung zählt eine Buchung, die der Verbrauch nicht zählt",
      ).toBe(0);
      expect(
        carry.consumedOtherCents,
        "`other` ist negativ — der Client verschluckt das und zeigt trotzdem "
        + "eine Dokumentiert-Zeile",
      ).toBe(0);
      expect(
        carry.consumedBilledCents + carry.consumedDocumentedCents + carry.consumedOtherCents,
        "die drei Teilbeträge ergeben nicht den Gesamt-Verbrauch des Topfes",
      ).toBe(carry.consumedCents);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("FS-7 – ein Storno NACH dem Stichtag zählt nicht mit", async () => {
    /**
     * Der `reversal`-Zweig war ungeprüft (Gate 2 zu #190, S4): der
     * Mutations-Gegencheck kippte FS-1..FS-3 über den `consumption`-Zweig, nie
     * über diesen. Ein Storno in der Zukunft hätte den Übertrags-Topf in jeder
     * Stichtagssicht künstlich aufgefüllt.
     *
     * Gerechnet: Verbrauch 80,00 € am 10.04. (nach dem Cutoff, zählt), Storno
     * am 20.06. (nach dem Stichtag 15.05., zählt NICHT). Der Topf trägt also
     * weiter 80,00 € Verbrauch.
     */
    const { id, uebertragId } = await kundeMitLage();
    try {
      await db.insert(budgetTransactions).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
          amountCents: -80_00, transactionDate: `${J}-04-10`,
          allocationId: uebertragId, description: "FS7-verbrauch",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "reversal",
          amountCents: 80_00, transactionDate: `${J}-06-20`,
          allocationId: uebertragId, description: "FS7-storno-nach-stichtag",
        },
      ] as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      expect(
        carry.consumedCents,
        "ein Storno nach dem Stichtag hat den Verbrauch rückwirkend aufgehoben",
      ).toBe(80_00);
      expect(carry.remainingCents).toBe(UEBERTRAG - 80_00);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("FS-8 – ein Storno VOR dem Reset-Cutoff zählt nicht mit", async () => {
    /**
     * Die andere Hälfte von S4. Verbrauch 60,00 € am 20.01. und Storno am
     * 25.01. — beide vor dem Cutoff 01.03., beide geschnitten. Der Topf ist
     * unberührt.
     *
     * Ohne den Schnitt am `reversal`-Zweig wäre der Verbrauch geschnitten und
     * das Storno nicht: der Topf hätte 60,00 € MEHR gezeigt als er hat.
     */
    const { id, uebertragId } = await kundeMitLage();
    try {
      await db.insert(budgetTransactions).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
          amountCents: -60_00, transactionDate: `${J}-01-20`,
          allocationId: uebertragId, description: "FS8-verbrauch-vor-reset",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "reversal",
          amountCents: 60_00, transactionDate: `${J}-01-25`,
          allocationId: uebertragId, description: "FS8-storno-vor-reset",
        },
      ] as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      expect(carry.consumedCents, "der geschnittene Bereich wirkt doch").toBe(0);
      expect(carry.remainingCents).toBe(UEBERTRAG);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
