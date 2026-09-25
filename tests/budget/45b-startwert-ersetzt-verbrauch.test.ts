import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { apiPost, createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { assertTestClockActive, clearTestClock, useTestClock } from "../helpers/test-clock";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

/**
 * Was ein Startwert ersetzt — und was er NICHT ersetzt.
 *
 * Der Startwert stellt den §45b-Bestand zum Monatsbeginn M fest (Glossar,
 * CLAUDE.md). Daraus folgen drei Regeln, alle in Tabelle D:
 *
 *   · Buchungen VOR dem 1. von M sind im Startwert abgebildet — sie zählen
 *     nicht mehr (Glied (b), seit #1812).
 *   · Buchungen AB dem 1. von M werden abgezogen (R4) — auch wenn sie auf
 *     eine Zuweisung verknüpft sind, die der Startwert ersetzt hat.
 *   · Die ABSCHREIBUNG einer ersetzten Zuweisung ist kein Verbrauch — sie ist
 *     der Verfall eines schon abgegoltenen Bestands (Ergänzung E2,
 *     „Doppelabschreibung").
 *
 * ── Der Fehler, den SE-1 festhält (N-P1) ────────────────────────────────
 * Der Reader führte EINE Liste für zwei Fragen: „trägt diese Zuweisung zum
 * Budget bei?" und „fällt ihr Verbrauch heraus?". Eine vom Startwert ersetzte
 * Zuweisung stand darauf — und mit ihr JEDER auf sie verknüpfte Verbrauch,
 * auch der nach dem Cutoff. Die Verfügbarkeit stand zu hoch, in der Richtung,
 * in der gebucht wird.
 *
 * Ohne Flag trifft das heute schon einen FRÜHEREN Startwert, den ein später
 * erfasster ersetzt: die Buchungen dazwischen hat die Engine auf den früheren
 * gestempelt. Mit dem geplanten Flip trifft es zusätzlich jeden verdrängten
 * Übertrag (Funke).
 */

const J = 2026;

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

async function verbrauch(id: number, datum: string, cents: number, allocationId: number | null,
  typ: "consumption" | "write_off" = "consumption"): Promise<void> {
  await db.insert(budgetTransactions).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: typ,
    amountCents: -cents, transactionDate: datum, allocationId, description: `SE-${typ}-${datum}`,
  } as never);
}

describe("§45b — was ein Startwert ersetzt, und was nicht", () => {
  beforeEach(() => { useTestClock(`${J}-09-25`); assertTestClockActive(); });
  afterEach(() => clearTestClock());

  it("SE-1 – eine Buchung NACH dem neuen Startwert zählt, auch auf dem ersetzten früheren (ohne Flag)", async () => {
    /**
     * Startwert März 300,00 €; später erfasst ein Startwert Mai 200,00 €.
     * Dazwischen hat die Engine gebucht und auf den März-Startwert gestempelt:
     *   50,00 € am 10.04. — VOR dem Mai-Cutoff, im Mai-Startwert abgebildet
     *   80,00 € am 10.05. — NACH dem Mai-Cutoff, zählt gegen den Mai-Startwert
     *
     * Zum 15.05.: Anspruch 200,00, Verbrauch 80,00, verfügbar 120,00.
     * Vorher verschwanden die 80,00 € mit dem ersetzten März-Startwert: 200,00 frei.
     */
    const id = await kunde();
    try {
      const [maerz] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${J}-03-01`, expiresAt: null, notes: "SE1-startwert-maerz",
      }).returning({ id: budgetAllocations.id });
      await verbrauch(id, `${J}-04-10`, 50_00, maerz.id);
      await verbrauch(id, `${J}-05-10`, 80_00, maerz.id);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 5,
        amountCents: 200_00, source: "initial_balance",
        validFrom: `${J}-05-01`, expiresAt: null, notes: "SE1-startwert-mai",
      });

      const t = (await readUnifiedBudgetAvailability(id, `${J}-05-15`)).pots.entlastungsbetrag_45b;
      expect(t.allocatedCents, "Anspruch = der jüngste Startwert").toBe(200_00);
      expect(
        t.consumedNetCents,
        "die Mai-Buchung auf dem ersetzten März-Startwert ist verschwunden (N-P1) — "
        + "oder die April-Buchung vor dem Cutoff zählt fälschlich mit",
      ).toBe(80_00);
      expect(t.availableCents).toBe(120_00);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("SE-2 – die Abschreibung eines ersetzten Übertrags zählt nicht, die Buchung darauf schon (Flag an)", async () => {
    /**
     * Unter dem Flip (hier ausdrücklich per Option) ersetzt ein Startwert März
     * den Übertrag. Auf dem Übertrag liegen:
     *   80,00 € Buchung am 10.04. — nach dem Cutoff, zählt (R4)
     *   15,00 € Abschreibung am 01.07. — Verfall des ersetzten Bestands, zählt NICHT (E2)
     *
     * Die Abschreibung trägt den 01.07. wie im echten Verfalls-Lauf
     * (`addDays(expiresAt, 1)`). Zum 15.07.: Verbrauch 80,00.
     */
    const id = await kunde();
    try {
      const [ue] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: 500_00, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "SE2-uebertrag",
      }).returning({ id: budgetAllocations.id });
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${J}-03-01`, expiresAt: null, notes: "SE2-startwert-maerz",
      });
      await verbrauch(id, `${J}-04-10`, 80_00, ue.id);
      await verbrauch(id, `${J}-07-01`, 15_00, ue.id, "write_off");

      const t = (await readUnifiedBudgetAvailability(
        id, `${J}-07-15`, undefined, { resetDisplacesAllSources: true },
      )).pots.entlastungsbetrag_45b;
      expect(
        t.consumedNetCents,
        "80,00 € Buchung zählt (R4), 15,00 € Abschreibung des ersetzten Übertrags nicht (E2)",
      ).toBe(80_00);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("SE-3 – ein von Hand überschriebener AUTOMATISCHER Übertrag trägt danach den Ersteller", async () => {
    /**
     * Das Merkmal, an dem der spätere Flip automatische von handeingetragenen
     * Überträgen unterscheidet (Tabelle D: „Was ich eingetragen habe, gilt").
     *
     * Die Automatik legt Überträge ohne Ersteller an. Trug danach jemand in
     * den Budget-Einstellungen einen Übertrag für dasselbe Jahr ein, wurde die
     * Automatik-Zeile überschrieben — Betrag von Hand, Ersteller weiter leer.
     * Geprüft auf der geschriebenen Zeile, über die echte Route.
     */
    const auth = await getAuthCookie();
    const id = await kunde();
    try {
      const [auto] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: 131_00, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`,
        notes: `Übertrag aus ${J - 1}: 131,00 € (verfällt 30.06.${J})`,
      }).returning({ id: budgetAllocations.id, createdByUserId: budgetAllocations.createdByUserId });
      expect(auto.createdByUserId, "Vorbedingung: die Automatik-Zeile hat keinen Ersteller").toBeNull();

      const r = await apiPost(`/api/budget/${id}/carryover/entlastungsbetrag_45b`, {
        sourceYear: J - 1, amountCents: 344_50,
      });
      expect([200, 201], JSON.stringify(r.data)).toContain(r.status);

      const [zeile] = await db.select().from(budgetAllocations).where(and(
        eq(budgetAllocations.id, auto.id),
      ));
      expect(zeile.amountCents, "Vorbedingung: DIESE Zeile wurde überschrieben, keine neue angelegt").toBe(344_50);
      expect(
        zeile.createdByUserId,
        "der von Hand eingetragene Übertrag sieht nach `created_by_user_id` weiter automatisch aus",
      ).toBe(auth.user.id);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
