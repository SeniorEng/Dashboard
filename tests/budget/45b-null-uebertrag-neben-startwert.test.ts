import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { apiPost, createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { calculateAllocatedCents } from "../../server/storage/budget/allocation-storage";

/**
 * Ein 0-€-Übertrag neben einem Startwert ist erlaubt und lässt den Anspruch
 * unverändert — gepinnt, nicht nur gemessen (Gate 2 zu #186, S6).
 *
 * ── Warum es diesen Test geben muss ────────────────────────────────────
 * Genau diese Messung war die BEGRÜNDUNG dafür, rund 90 Fixtures mit
 * `carryoverAmountCents: 0` unverändert zu lassen: „eine 0-€-Übertragszeile
 * neben einem Startwert lässt den Anspruch unverändert (39.300 mit und ohne)".
 *
 * Sie stand als Zahl im Kommentar und im PR-Body — und nirgends als Prüfung.
 * Eine tragende Messung ohne Test ist eine Behauptung mit Verfallsdatum: sie
 * gilt, bis jemand `displacedByReset` anfasst, und niemand erfährt es.
 *
 * ── NU-2 ist am 24.09.2026 entfallen ───────────────────────────────────
 * Er sicherte die Ablehnung „Startwert + Übertrag > 0". Die gibt es nicht
 * mehr: nach Alriks Entscheidungstabelle v2 melden die Kassen beide Beträge
 * getrennt, und im ersten Halbjahr sind beide Pflicht. Die Ablehnung beruhte
 * auf einer Prämisse, die Schritt C widerlegt hat.
 *
 * NU-1 bleibt unberührt — er sagt etwas über die 0, nicht über die
 * Kombination.
 */

const JAHR = 2026;
const STARTWERT = 184_60;
const MONATSRATE = 131_00;

async function kunde(): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${JAHR - 1}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  return id;
}

async function zeilen(customerId: number) {
  return db.select({ source: budgetAllocations.source, amountCents: budgetAllocations.amountCents })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    ))
    .orderBy(budgetAllocations.source);
}

describe("§45b — 0-€-Übertrag neben einem Startwert", () => {
  it("NU-1 – wird angenommen und ändert den Anspruch nicht", async () => {
    const mit = await kunde();
    const ohne = await kunde();
    try {
      const resMit = await apiPost<any>(`/api/budget/${mit}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: STARTWERT,
        carryoverAmountCents: 0,
        budgetStartDate: `${JAHR}-06-01`,
      });
      expect([200, 201], `die 0 neben dem Startwert wurde abgelehnt: ${JSON.stringify(resMit.data)}`)
        .toContain(resMit.status);

      const resOhne = await apiPost<any>(`/api/budget/${ohne}/initial-budget`, {
        budgetType: "entlastungsbetrag_45b",
        currentMonthAmountCents: STARTWERT,
        budgetStartDate: `${JAHR}-06-01`,
      });
      expect([200, 201]).toContain(resOhne.status);

      /**
       * Erst die Substanz: die 0-Zeile EXISTIERT. Ohne diese Prüfung wäre die
       * Gleichheit unten auch dann erfüllt, wenn die Route die 0 wieder
       * wegfaltet — also genau dann, wenn S5 zurückgenommen wäre.
       */
      expect(
        (await zeilen(mit)).filter(z => z.source === "carryover"),
        "die festgestellte Null hat keine Übertragszeile erzeugt",
      ).toEqual([{ source: "carryover", amountCents: 0 }]);
      expect(
        (await zeilen(ohne)).filter(z => z.source === "carryover"),
        "ohne Angabe ist trotzdem eine Übertragszeile entstanden",
      ).toEqual([]);

      // Und jetzt die eigentliche Zusage.
      const anspruchMit = await calculateAllocatedCents(mit, "entlastungsbetrag_45b", {
        asOfDate: `${JAHR}-08-15`,
      });
      const anspruchOhne = await calculateAllocatedCents(ohne, "entlastungsbetrag_45b", {
        asOfDate: `${JAHR}-08-15`,
      });

      expect(
        anspruchMit,
        "die 0-€-Übertragszeile hat den Anspruch verändert — dann trägt die "
        + "Begründung nicht mehr, ~90 Fixtures mit `carryoverAmountCents: 0` "
        + "unverändert zu lassen",
      ).toBe(anspruchOhne);

      /**
       * Eine konkrete Zahl daneben, nicht nur die Gleichheit.
       *
       * Sonst wäre die Zusage auch erfüllt, wenn BEIDE Seiten 0 liefern —
       * derselbe Fehler, den `VD-5` einmal hatte (die Fixture erfüllte die
       * Zusage auch ohne den Fix).
       *
       * Startwert im Juni + Aufstockung Juli/August: 184,60 + 2 × 131,00.
       */
      expect(anspruchMit, "die Größenordnung stimmt nicht — Fixture prüfen")
        .toBe(STARTWERT + 2 * MONATSRATE);
    } finally {
      await cleanupCustomer(mit);
      await cleanupCustomer(ohne);
    }
  }, 120_000);

});
