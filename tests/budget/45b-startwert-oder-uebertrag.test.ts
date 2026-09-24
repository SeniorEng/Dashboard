import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { applyInitialBudget, BudgetInitialSetupError } from "../../server/services/budget-initial-setup";

/**
 * ENTWEDER Startwert ODER Übertrag — nie beides (Alrik, 24.09.2026).
 *
 * ── Warum das eine Ablehnung ist und keine Warnung ──────────────────────
 * Seit dem Scharfschalten der Inventur-Lesart verdrängt ein Startwert für
 * Monat M jede Zuweisung, deren Gültigkeit vor M beginnt. `applyInitialBudget`
 * schreibt beide in EINER Transaktion: der Übertrag trägt
 * `validFrom = ${year}-01-01` und `year = year`, der Startwert einen Monat
 * desselben Jahres — `displacedByReset` ist damit **immer** wahr.
 *
 * Gemessen (Gate 2 zu #184, B3): Startwert 100,00 € + Übertrag 500,00 € ab
 * 01/2026 ergaben einen Anspruch von 755,00 € statt 1.255,00 €. Der Übertrag
 * war eingegeben, gegen seinen eigenen Cap validiert, quittiert — und
 * wirkungslos.
 *
 * **Angenommen, quittiert, verworfen** ist die schlechteste Kombination. Eine
 * Warnung wäre zu wenig: der Anwender hat keine Möglichkeit, „beides" zu
 * meinen, weil eine Inventur den Übertrag einschließt.
 *
 * ── Drei Schichten ──────────────────────────────────────────────────────
 * Die Prüfung sitzt in `applyInitialBudget`, also hinter BEIDEN Wegen — dem
 * Anlage-Assistenten (`customer-creation-helpers`) und
 * `POST /budget/:id/initial-budget`. Der Client blendet das Feld zusätzlich
 * aus; das ist Bequemlichkeit, nicht die Schranke.
 */

const JAHR = new Date().getFullYear();
const START = `${JAHR}-01-15`;

async function kunde(): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  /**
   * Pflegegrad seit dem VORJAHR — sonst ist der Übertrags-Cap 0.
   *
   * `max45bCarryoverCents(eligible45bCarryoverMonths(anker, jahr))` zählt die
   * im Vorjahr berechtigten Monate. Eine erste Fassung löschte die Historie
   * ganz; `EO-4` (nur Übertrag) scheiterte dann am Cap statt an der neuen
   * Regel — der Test hätte aus dem falschen Grund rot gestanden.
   */
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
  });
  return id;
}

async function zeilen(customerId: number) {
  return db.select({ source: budgetAllocations.source, amountCents: budgetAllocations.amountCents })
    .from(budgetAllocations)
    .where(eq(budgetAllocations.customerId, customerId));
}

describe("§45b-Onboarding — Startwert und Übertrag schließen sich aus", () => {
  it("EO-1 – beides zusammen wird ABGELEHNT, und es wird nichts geschrieben", async () => {
    const id = await kunde();
    try {
      await expect(applyInitialBudget({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 100_00,
        carryoverAmountCents: 500_00,
      })).rejects.toThrow(BudgetInitialSetupError);

      // Der Kern: kein Teil-Schreiben. „Angenommen, quittiert, verworfen" wäre
      // schlimmer als eine Ablehnung.
      expect(
        await zeilen(id),
        "trotz Ablehnung wurde etwas geschrieben",
      ).toEqual([]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-2 – der Fehler nennt die Frage, die der Anwender beantworten muss", async () => {
    const id = await kunde();
    try {
      await applyInitialBudget({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 100_00,
        carryoverAmountCents: 500_00,
      });
      throw new Error("keine Ablehnung");
    } catch (e) {
      const fehler = e as BudgetInitialSetupError;
      expect(fehler.code, "der Fehlercode ist nicht der erwartete")
        .toBe("BUDGET_45B_STARTWERT_ODER_UEBERTRAG");
      expect(
        fehler.message,
        "die Meldung sagt nicht, WAS zu tun ist — dann rät der Anwender",
      ).toContain("Restbestand bekannt");
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-3 – nur Startwert wird angenommen", async () => {
    // Die Gegenrichtung. Ohne sie wäre EO-1 auch dadurch erfüllt, dass der
    // Pfad ÜBERHAUPT nichts mehr annimmt.
    const id = await kunde();
    try {
      await applyInitialBudget({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 100_00,
      });
      expect(await zeilen(id), "der Startwert allein wurde nicht geschrieben")
        .toEqual([{ source: "initial_balance", amountCents: 100_00 }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-4 – nur Übertrag wird angenommen", async () => {
    const id = await kunde();
    try {
      await applyInitialBudget({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        carryoverAmountCents: 500_00,
      });
      expect(await zeilen(id), "der Übertrag allein wurde nicht geschrieben")
        .toEqual([{ source: "carryover", amountCents: 500_00 }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-5 – die festgestellte Null zählt als Angabe", async () => {
    /**
     * `0 €` ist nach Alriks Entscheidung vom 22.09.2026 eine festgestellte
     * Null, keine fehlende Eingabe — und sie verdrängt genauso.
     *
     * Die Prüfung hängt deshalb an `!= null`, nicht an `> 0`. Genau dieser
     * Fall (0-€-Startwert neben einem Übertrag) war der teuerste: der
     * Übertrag fällt vollständig weg, und niemand hat einen Betrag
     * eingegeben, der gewarnt werden könnte.
     */
    const id = await kunde();
    try {
      await expect(applyInitialBudget({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 0,
        carryoverAmountCents: 500_00,
      })).rejects.toThrow(BudgetInitialSetupError);
      expect(await zeilen(id)).toEqual([]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-6 – §45a wird NICHT vom Entweder-oder getroffen (sondern von seiner eigenen Regel)", async () => {
    /**
     * Die Zusage ist unverändert: die Inventur-Lesart ist §45b-spezifisch, und
     * das Entweder-oder gilt für §45a nicht.
     *
     * Der erwartete AUSGANG hat sich am 24.09.2026 geändert. §45a mit Startwert
     * UND Übertrag wird jetzt ebenfalls abgelehnt — aber aus einem anderen
     * Grund: für §45a entsteht gar keine Übertragszeile, der Betrag wäre
     * angenommen, protokolliert und nicht gespeichert (Gate 2 zum B1-Delta,
     * S-1).
     *
     * Deshalb prüft der Test jetzt den CODE der Ablehnung. Genau das ist die
     * Unterscheidung, die er tragen soll: träfe hier
     * `BUDGET_45B_STARTWERT_ODER_UEBERTRAG`, hätte sich die §45b-Regel auf
     * §45a ausgedehnt — und das wäre der Fehler, gegen den EO-6 seit jeher
     * steht.
     */
    const id = await kunde();
    try {
      await applyInitialBudget({
        customerId: id,
        budgetType: "umwandlung_45a",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 100_00,
        carryoverAmountCents: 500_00,
      });
      throw new Error("keine Ablehnung");
    } catch (e) {
      const fehler = e as BudgetInitialSetupError;
      expect(
        fehler.code,
        "§45a wurde von der §45b-Regel getroffen — die Inventur-Lesart hat sich ausgedehnt",
      ).toBe("BUDGET_CARRYOVER_NUR_45B");
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);

  it("EO-7 – §45a mit Startwert allein wird geschrieben", async () => {
    // Die Gegenrichtung zu EO-6: ohne Übertrag nimmt §45a den Startwert an.
    // Ohne diesen Test wäre EO-6 auch erfüllt, wenn §45a gar nichts mehr
    // annimmt.
    const id = await kunde();
    try {
      await applyInitialBudget({
        customerId: id,
        budgetType: "umwandlung_45a",
        budgetStartDate: START,
        customer: { billingType: "pflegekasse_gesetzlich", pflegegrad: 3 },
        currentMonthAmountCents: 100_00,
      });
      expect(await zeilen(id), "der §45a-Startwert allein wurde nicht geschrieben")
        .toEqual([{ source: "initial_balance", amountCents: 100_00 }]);
    } finally {
      await cleanupCustomer(id);
    }
  }, 60_000);
});
