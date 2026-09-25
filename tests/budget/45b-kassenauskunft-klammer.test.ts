import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { calculateAllocatedCents } from "../../server/storage/budget/allocation-storage";
import { displacedByReset } from "../../server/storage/budget/allocation-window";

/**
 * Die Vorgangs-Klammer entscheidet über die Verdrängung.
 * (Cowork/Alrik, 24.09.2026 — Modell v2, Entscheidungstabelle im Stammticket.)
 *
 * ── Zwei Zusagen ────────────────────────────────────────────────────────
 * 1. **Ohne Klammer verdrängt nichts.** Der Altbestand rechnet exakt wie
 *    heute. Das ist der Fall, der die beiden möglichen Lesarten von `null`
 *    unterscheidet — und `E1` kann ihn NICHT prüfen, weil `E1` gar keinen
 *    Startwert hat und damit keinen Reset-Anker.
 * 2. **Die Zeilen desselben Vorgangs zählen**, auch die Übertragszeile, deren
 *    `validFrom` der Stichtag selbst ist. Ohne diese Ausnahme verdrängte der
 *    Stichtag seine eigene Zeile.
 */

const J = 2026;
const UEBERTRAG = 500_00;
const STARTWERT = 300_00;
const MONATSRATE = 131_00;

async function kunde(): Promise<number> {
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
  return id;
}

describe("§45b — die Vorgangs-Klammer", () => {
  it("KL-1 – OHNE Klammer rechnet der Altbestand exakt wie heute", async () => {
    /**
     * **Der Fall, der die Lesarten unterscheidet.**
     *
     * Ein Startwert ohne Klammer neben einem gültigen Übertrag. Lesart „null =
     * eigener Vorgang" würde den Übertrag verdrängen (das #184-Verhalten,
     * −20.395,73 € auf dem Prod-Bestand). Lesart „null verdrängt nichts"
     * lässt ihn stehen.
     *
     * Erwartet ist die zweite — mit der HEUTIGEN Zahl als Vorgabe, nicht mit
     * einer, die aus der neuen Regel abgeleitet wäre.
     *
     * Gerechnet zum 15.05.: Übertrag 500 + Startwert 300 (März)
     *   + 2 × 131 (April, Mai) = 1.062,00 €
     */
    const id = await kunde();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: UEBERTRAG, source: "carryover",
          validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "KL1-ue",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
          amountCents: STARTWERT, source: "initial_balance",
          validFrom: `${J}-03-01`, expiresAt: null, notes: "KL1-sw",
        },
      ]);

      const mitFlag = await calculateAllocatedCents(id, "entlastungsbetrag_45b", {
        asOfDate: `${J}-05-15`, resetDisplacesAllSources: true,
      });
      expect(
        mitFlag,
        "ein Startwert OHNE Klammer hat den Übertrag verdrängt — der Altbestand "
        + "rechnet nicht mehr wie heute",
      ).toBe(UEBERTRAG + STARTWERT + 2 * MONATSRATE);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("KL-2 – MIT Klammer verdrängt der Stichtag den älteren Übertrag", async () => {
    // Die Gegenrichtung. Ohne sie wäre KL-1 auch erfüllt, wenn die Verdrängung
    // überhaupt nicht mehr greift.
    const id = await kunde();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: UEBERTRAG, source: "carryover",
          validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "KL2-alt",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
          amountCents: STARTWERT, source: "initial_balance",
          validFrom: `${J}-03-01`, expiresAt: null, notes: "KL2-sw",
          kassenauskunftId: 4711,
        },
      ]);

      const mitFlag = await calculateAllocatedCents(id, "entlastungsbetrag_45b", {
        asOfDate: `${J}-05-15`, resetDisplacesAllSources: true,
      });
      expect(
        mitFlag,
        "der ältere Übertrag wurde nicht verdrängt",
      ).toBe(STARTWERT + 2 * MONATSRATE);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("KL-3 – die Übertragszeile DESSELBEN Vorgangs überlebt ihren eigenen Stichtag", async () => {
    /**
     * Der Fall, an dem die Regel ohne Klammer bricht: die neue Übertragszeile
     * trägt `validFrom = Stichtag`, und `validFrom <= cutoffDate` ist damit
     * erfüllt. Ohne die Vorgangs-Ausnahme löschte der Stichtag seine eigene
     * Zeile.
     *
     * Gerechnet: Übertrag 500 (ab März, gleiche Klammer) + Startwert 300
     *   + 2 × 131 = 1.062,00 €. Der ALTE Übertrag ab Januar fällt weg.
     */
    const id = await kunde();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: 900_00, source: "carryover",
          validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "KL3-alt",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
          amountCents: STARTWERT, source: "initial_balance",
          validFrom: `${J}-03-01`, expiresAt: null, notes: "KL3-sw",
          kassenauskunftId: 4712,
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: UEBERTRAG, source: "carryover",
          validFrom: `${J}-03-01`, expiresAt: `${J}-06-30`, notes: "KL3-neu",
          kassenauskunftId: 4712,
        },
      ]);

      const mitFlag = await calculateAllocatedCents(id, "entlastungsbetrag_45b", {
        asOfDate: `${J}-05-15`, resetDisplacesAllSources: true,
      });
      expect(
        mitFlag,
        "der Stichtag hat die Übertragszeile seines EIGENEN Vorgangs verdrängt",
      ).toBe(UEBERTRAG + STARTWERT + 2 * MONATSRATE);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("KL-4 – die Funktion und ihr SQL-Spiegel sagen dasselbe", async () => {
    /**
     * `displacedByReset` und `notDisplacedByResetWhere` sind als Spiegel
     * benannt. Eine Zusage, die an Gleichschritt hängt statt an einer
     * gemeinsamen Funktion, gilt nur so lange, bis jemand eine Seite anfasst —
     * deshalb hier ausdrücklich geprüft, an allen vier Kombinationen.
     */
    const anker = { cutoffDate: `${J}-03-01`, year: J, month: 3, kassenauskunftId: 4711 };
    const ohneKlammer = { cutoffDate: `${J}-03-01`, year: J, month: 3, kassenauskunftId: null };

    expect({
      alt_fremde_Klammer: displacedByReset(
        { validFrom: `${J}-01-01`, expiresAt: null, year: J, kassenauskunftId: 999 } as never, anker),
      alt_ohne_Klammer: displacedByReset(
        { validFrom: `${J}-01-01`, expiresAt: null, year: J, kassenauskunftId: null } as never, anker),
      gleiche_Klammer: displacedByReset(
        { validFrom: `${J}-03-01`, expiresAt: null, year: J, kassenauskunftId: 4711 } as never, anker),
      anker_ohne_Klammer: displacedByReset(
        { validFrom: `${J}-01-01`, expiresAt: null, year: J, kassenauskunftId: null } as never, ohneKlammer),
    }).toEqual({
      alt_fremde_Klammer: true,
      alt_ohne_Klammer: true,
      gleiche_Klammer: false,
      anker_ohne_Klammer: false,
    });
  });
  it("KL-5 – auch der SQL-Pfad verdrängt ohne Klammer nichts", async () => {
    /**
     * `KL-1` prüft den Anspruch über `calculateAllocatedCents`. Der geht über
     * die TypeScript-Fassung `displacedByReset`. Die SQL-Fassung
     * `notDisplacedByResetWhere` wird dort **nicht** berührt.
     *
     * Der Mutations-Gegencheck hat die Lücke gezeigt: das Entfernen der
     * null-Behandlung im SQL-Spiegel ließ `KL-1`…`KL-4` grün. Laufen die
     * beiden auseinander, meldet der Anspruch etwas anderes als die
     * Topf-Aufteilung — und genau diese Differenz war der Fehler aus #180
     * (`allocatedCur` kippte auf −1.048,00 €).
     *
     * `readBudget45bFifoBreakdown` geht über den SQL-Pfad.
     */
    const id = await kunde();
    try {
      await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
          amountCents: UEBERTRAG, source: "carryover",
          validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "KL5-ue",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
          amountCents: STARTWERT, source: "initial_balance",
          validFrom: `${J}-03-01`, expiresAt: null, notes: "KL5-sw",
        },
      ]);

      const { readBudget45bFifoBreakdown } = await import("../../server/storage/budget/fifo-breakdown");
      const b = await readBudget45bFifoBreakdown(id, `${J}-05-15`, { resetDisplacesAllSources: true });
      const carry = b.pots.find(p => p.potType === "carryover")!;

      expect(
        carry.allocatedCents,
        "der SQL-Pfad hat den Übertrag verdrängt, obwohl der Anker keine "
        + "Klammer trägt — die beiden Fassungen laufen auseinander",
      ).toBe(UEBERTRAG);
      expect(
        b.totalAllocatedCents,
        "und damit weicht die Summe vom Anspruch ab",
      ).toBe(UEBERTRAG + STARTWERT + 2 * MONATSRATE);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
