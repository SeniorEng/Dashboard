import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations, budgetTransactions, customerBudgetTypeSettings, customerCareLevelHistory,
} from "@shared/schema";
import { apiGet, apiPost, createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
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
 *     „Doppelabschreibung“).
 *
 * ── Der Fehler, den SE-1 festhält (N-P1) ────────────────────────────────
 * Der Reader führte EINE Liste für zwei Fragen: „trägt diese Zuweisung zum
 * Budget bei?" und „fällt ihr Verbrauch heraus?“. Eine vom Startwert ersetzte
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
     * Überträgen unterscheidet (Tabelle D: „Was ich eingetragen habe, gilt“).
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
  it("SE-4 – eine Buchung aus einem FRÜHEREN Jahr auf einem ersetzten Startwert zählt nicht (B-1)", async () => {
    /**
     * Tabelle D (Alrik, 25.09.2026): eine Buchung auf einer vom Startwert
     * ersetzten Zuweisung zählt nur im LAUFENDEN Anspruchsfenster. Frühere
     * Jahre stecken im Übertrag oder sind verfallen.
     *
     * Gate 2 zu #193, B-1 — der erste Fix ließ genau das zu. Gemessen:
     *
     *   Lage                                vor #193        erster Fix
     *   (a) mit Übertrag 2026, 15.03.2026   0,00 / 593,00   100,00 / 493,00
     *   (b) ohne Übertrag,     15.09.2026   0,00 / 1.179,00 100,00 / 1.079,00
     *   (Verbrauch / verfügbar)
     *
     * Startwert 05/2025 über 300,00 €, eine Buchung von 100,00 € am 10.06.2025
     * auf diesen Startwert. Sie gehört zu 2025 — im Übertrag 2026 abgebildet
     * bzw. verfallen — und darf 2026 nicht noch einmal abgehen. Die
     * Verfügbarkeit stünde sonst zu NIEDRIG, und Kassen-Anteile gingen privat.
     *
     * ⚠ Dieser Fall bezeugt KEINEN der zwei Fix-Teile einzeln (gemessen per
     * Mutation): der Startwert 05/2025 ist hier selbst der Anker, und
     * „echt früher“ allein nimmt ihn aus „ersetzt“ heraus, die Boden-Grenze
     * allein schneidet die Buchung ab. Die Einzel-Zeugen: SE-5 (Boden) und
     * EK-3 (echt früher, an der Anzeige).
     */
    const lage = async (): Promise<number> => {
      const id = await kunde();
      await db.update(customerBudgetTypeSettings)
        .set({ validFrom: `${J - 1}-01-01` })
        .where(eq(customerBudgetTypeSettings.customerId, id));
      const [sw] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J - 1, month: 5,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${J - 1}-05-01`, expiresAt: null, notes: "SE4-startwert-2025",
      }).returning({ id: budgetAllocations.id });
      await verbrauch(id, `${J - 1}-06-10`, 100_00, sw.id);
      return id;
    };

    const a = await lage();
    try {
      await db.insert(budgetAllocations).values({
        customerId: a, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: 200_00, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "SE4-uebertrag-2026",
      });
      const t = (await readUnifiedBudgetAvailability(a, `${J}-03-15`)).pots.entlastungsbetrag_45b;
      expect(t.consumedNetCents, "(a) die Juni-2025-Buchung zählt gegen 2026, obwohl sie im Übertrag steckt").toBe(0);
      expect(t.availableCents).toBe(593_00);
    } finally {
      await cleanupCustomer(a);
    }

    const b = await lage();
    try {
      const t = (await readUnifiedBudgetAvailability(b, `${J}-09-15`)).pots.entlastungsbetrag_45b;
      expect(t.consumedNetCents, "(b) die Juni-2025-Buchung zählt gegen 2026, obwohl sie verfallen ist").toBe(0);
      expect(t.availableCents).toBe(1_179_00);
    } finally {
      await cleanupCustomer(b);
    }
  }, 180_000);
  it("SE-5 – die Boden-Grenze: Buchung eines Vorjahres auf einem WIRKLICH ersetzten Startwert", async () => {
    /**
     * Der Einzel-Zeuge für die Boden-Grenze in Glied (a').
     *
     * Startwert 03/2025, später ersetzt durch Startwert 05/2025 (der Anker).
     * Die Engine hatte am 10.06.2025 noch auf den 03er gestempelt — er ist
     * ECHT früher als der Anker, also „ersetzt“. Die Buchung liegt NACH dem
     * Anker-Cutoff 01.05.2025, Glied (b) schneidet sie nicht. Im laufenden
     * Anspruchsfenster 2026 darf sie trotzdem nicht zählen: sie gehört zu 2025.
     */
    const id = await kunde();
    try {
      await db.update(customerBudgetTypeSettings)
        .set({ validFrom: `${J - 1}-01-01` })
        .where(eq(customerBudgetTypeSettings.customerId, id));
      const [maerz] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J - 1, month: 3,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${J - 1}-03-01`, expiresAt: null, notes: "SE5-startwert-03-2025",
      }).returning({ id: budgetAllocations.id });
      await verbrauch(id, `${J - 1}-06-10`, 100_00, maerz.id);
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J - 1, month: 5,
        amountCents: 250_00, source: "initial_balance",
        validFrom: `${J - 1}-05-01`, expiresAt: null, notes: "SE5-startwert-05-2025",
      });
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: 200_00, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "SE5-uebertrag-2026",
      });

      const t = (await readUnifiedBudgetAvailability(id, `${J}-03-15`)).pots.entlastungsbetrag_45b;
      expect(
        t.consumedNetCents,
        "eine Buchung von 2025 auf einem ersetzten Startwert zählt gegen 2026",
      ).toBe(0);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
  it("EK-3 – der Anker-Startwert ist nicht „ersetzt durch sich selbst“, ein früherer schon", async () => {
    /**
     * Der Einzel-Zeuge für „echt früher als der Anker“ (Tabelle D) —
     * geprüft an der Kennzeichnung, die die Startwert-Liste ausliefert
     * (`GET /api/budget/:id/initial-balances/:budgetType`, `ersetztDurchStartwertMonat`).
     *
     * Zwei Startwerte 2025 (03 und 05), gelesen im September 2026: beide zählen
     * nicht mehr (Vorjahr, unter dem Aufstockungs-Boden). Der 05er ist der
     * Anker. `displacedByReset` träfe ihn selbst (`validFrom == cutoffDate`) —
     * die Liste zeigte dann „ersetzt durch Startwert 05/2025“ an Startwert
     * 05/2025 (Gate 2 zu #193, S-1).
     */
    const id = await kunde();
    try {
      await db.update(customerBudgetTypeSettings)
        .set({ validFrom: `${J - 1}-01-01` })
        .where(eq(customerBudgetTypeSettings.customerId, id));
      const [m3, m5] = await db.insert(budgetAllocations).values([
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J - 1, month: 3,
          amountCents: 300_00, source: "initial_balance",
          validFrom: `${J - 1}-03-01`, expiresAt: null, notes: "EK3-startwert-03",
        },
        {
          customerId: id, budgetType: "entlastungsbetrag_45b", year: J - 1, month: 5,
          amountCents: 250_00, source: "initial_balance",
          validFrom: `${J - 1}-05-01`, expiresAt: null, notes: "EK3-startwert-05",
        },
      ]).returning({ id: budgetAllocations.id });

      const r = await apiGet<Array<{ id: number; ersetztDurchStartwertMonat: string | null }>>(
        `/api/budget/${id}/initial-balances/entlastungsbetrag_45b`,
      );
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const zeile = (zid: number) => r.data.find(z => z.id === zid)!;
      expect(
        zeile(m5.id).ersetztDurchStartwertMonat,
        "der Anker-Startwert wird als „ersetzt durch sich selbst“ angezeigt",
      ).toBeNull();
      expect(
        zeile(m3.id).ersetztDurchStartwertMonat,
        "der wirklich ersetzte frühere Startwert wird nicht als ersetzt angezeigt",
      ).toBe(`05/${J - 1}`);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
