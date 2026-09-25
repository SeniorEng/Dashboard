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
 * Die Zustands-Aufteilung sieht dieselbe AUSSCHLUSS-Menge wie der Reader.
 * (Ticket `6hcfP7xVj5R3Pg6p`, Gate 2 zu #190, S-1.)
 *
 * ── Der Fehler ──────────────────────────────────────────────────────────
 * Der Reader schneidet den gezählten Verbrauch mit DREI Gliedern:
 *
 *   (a) `allocationId IN excludedSpecialAllocationIds`
 *   (b) `transactionDate < resetAnchor.cutoffDate`
 *   (c) `allocationId IS NULL AND transactionDate < accrualFloorDate`
 *
 * `classifyConsumedByState` bekam über `countedConsumptionWhere` nur (b) und
 * die as-of-Schranke. Die Begründung dafür — „(a) und (c) treffen hier nicht
 * zu“ — hängt an der Einschränkung auf Allocation-IDs, und genau die hat diese
 * Abfrage nicht: sie läuft kundenweit und nimmt `allocationId IS NULL`
 * ausdrücklich mit.
 *
 * ── Warum es auffällt und warum nicht ───────────────────────────────────
 * `other = consumedTotal − billed − documented` wird negativ. Der Client
 * verwirft negative Werte (`budget-45b-fifo-breakdown.tsx`: `value <= 0 →
 * null`), rendert aber die positive „Dokumentiert“-Zeile daneben. Der Nutzer
 * sieht „Dokumentiert: 100,00 €“ neben einem Verbrauch von 0.
 *
 * Beide Fälle unten sind ERREICHBAR, keine Konstruktion: `AC-2` trifft jeden
 * Kunden ohne Startwert, der im Vorjahr dokumentierte §45b-Termine auf dem
 * NULL-Leg hatte.
 *
 * ── Ein dritter Fall stand hier und ist BEWUSST wieder weg ───────────────
 * Schritt B hat ihn freigelegt: bei deaktiviertem §45b liefert der Reader
 * einen leeren Topf, die Aufschlüsselung rechnet aber weiter — gemessen
 * Anspruch +500,00 € im Übertrags-Topf neben einem Reader, der 0 sagt.
 *
 * Er gehört NICHT hierher, aus zwei Gründen: es ist kein Schnitt-Problem
 * (das Aktivierungs-Tor fehlt, nicht ein Ausschluss-Glied), und der Fix
 * dieses Vorgangs ändert ihn nachweislich nicht — gemessen identisch vor und
 * nach der Umstellung. Eigener Vorgang: `6hcfhqhjmgPW8q2G` [P1], dort stehen
 * die Zahlen.
 *
 * Ein Test, der das heutige falsche Verhalten festschreibt, wäre schlimmer
 * als keiner; einer ohne Zusage ist kein Test. Deshalb Messung im Ticket,
 * nicht als grüner Haken hier.
 */

const J = 2026;
const UEBERTRAG = 500_00;
const BETRAG = 100_00;

async function kunde(): Promise<number> {
  await getAuthCookie();
  const id = (await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  })).id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerCareLevelHistory).values({
    customerId: id, pflegegrad: 3, validFrom: `${J - 3}-01-01`, validTo: null,
  });
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${J - 2}-01-01`, validTo: null,
  });
  return id;
}

/** Dokumentierter Termin (fertig + unterschrieben, nicht abgerechnet). */
async function dokumentierterTermin(id: number, datum: string): Promise<number> {
  const [t] = await db.insert(appointments).values({
    customerId: id, date: datum, scheduledStart: "09:00", durationPromised: 60,
    status: "completed", signatureData: "data:image/png;base64,AAA",
    appointmentType: "Betreuung",
  } as never).returning({ id: appointments.id });
  return t.id;
}

/**
 * Die Zusage, in EINER Form für alle Fälle: was die Aufteilung zählt, zählt
 * auch der Verbrauch — und nichts davon ist negativ.
 *
 * Bewusst auf den ausgelieferten Zahlen, nicht auf einem Testhaken. Ein Feld,
 * das nur für die Prüfung entstünde, wäre ab diesem Moment Teil des Prüflings.
 */
function pruefeAufteilung(topf: {
  potType: string; consumedCents: number;
  consumedBilledCents: number; consumedDocumentedCents: number; consumedOtherCents: number;
}): void {
  expect(
    topf.consumedOtherCents,
    `Topf „${topf.potType}“: „sonstiger Verbrauch“ ist negativ `
    + `(${topf.consumedOtherCents}) — die Zustands-Aufteilung zählt eine Buchung, `
    + "die der Verbrauch nicht zählt",
  ).toBeGreaterThanOrEqual(0);
  expect(
    topf.consumedBilledCents + topf.consumedDocumentedCents + topf.consumedOtherCents,
    `Topf „${topf.potType}“: die drei Teilbeträge ergeben nicht den Gesamt-Verbrauch`,
  ).toBe(topf.consumedCents);
}

describe("§45b-FIFO — die Zustands-Aufteilung folgt allen drei Ausschluss-Gliedern", () => {
  beforeEach(() => {
    useTestClock(`${J}-08-15`);
    assertTestClockActive();
  });
  afterEach(() => clearTestClock());

  it("AC-1 – Glied (a): Verbrauch gegen einen ABGELAUFENEN Übertrag", async () => {
    /**
     * Der Übertrag ist zum Stichtag verfallen (30.06., Stichtag 15.08.). Der
     * Reader nimmt ihn aus `Allocated` und den dagegen gebuchten Verbrauch
     * symmetrisch aus `C` — Glied (a). Die Aufteilung zählte ihn weiter.
     *
     * Erwartung: `consumedDocumented` = 0 im Topf „laufendes Jahr“, und
     * `consumedOther` NICHT negativ.
     */
    const id = await kunde();
    try {
      const [ue] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: UEBERTRAG, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "AC1-uebertrag-verfallen",
      }).returning({ id: budgetAllocations.id });

      const termin = await dokumentierterTermin(id, `${J}-04-10`);
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -BETRAG, transactionDate: `${J}-04-10`,
        allocationId: ue.id, appointmentId: termin,
        description: "AC1-gegen-verfallenen-uebertrag",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-08-15`);
      const uni = await readUnifiedBudgetAvailability(id, `${J}-08-15`);

      // Vorbedingung: der Reader zählt diesen Verbrauch NICHT.
      expect(
        uni.pots.entlastungsbetrag_45b.consumedNetCents,
        "Vorbedingung verletzt — der Reader zählt den Verbrauch doch, dann "
        + "prüft dieser Test nicht das Gemeinte",
      ).toBe(0);

      for (const topf of fifo.pots) pruefeAufteilung(topf);
      const lauf = fifo.pots.find(p => p.potType === "current_year")!;
      expect(
        lauf.consumedDocumentedCents,
        "der Verbrauch gegen den verfallenen Übertrag erscheint weiter als "
        + "„dokumentiert“ — genau die Zeile, die der Client rendert",
      ).toBe(0);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("AC-2 – Glied (c): Verbrauch im VORJAHR ohne Allocation-Zuordnung", async () => {
    /**
     * Der häufigere der beiden Fälle: kein Startwert, kein Übertrag, nur eine
     * Buchung auf dem NULL-Leg aus dem Vorjahr. Der Reader nimmt sie über den
     * `accrualFloorDate`-Boden heraus — Glied (c) —, weil sie zu Monaten
     * gehört, die aus `Allocated` herausgefallen sind.
     */
    const id = await kunde();
    try {
      const termin = await dokumentierterTermin(id, `${J - 1}-11-20`);
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -BETRAG, transactionDate: `${J - 1}-11-20`,
        allocationId: null, appointmentId: termin,
        description: "AC2-vorjahr-null-leg",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-08-15`);
      const uni = await readUnifiedBudgetAvailability(id, `${J}-08-15`);

      expect(
        uni.pots.entlastungsbetrag_45b.consumedNetCents,
        "Vorbedingung verletzt — der Reader zählt die Vorjahres-Buchung doch",
      ).toBe(0);

      for (const topf of fifo.pots) pruefeAufteilung(topf);
      const lauf = fifo.pots.find(p => p.potType === "current_year")!;
      expect(
        lauf.consumedDocumentedCents,
        "die Vorjahres-Buchung auf dem NULL-Leg erscheint weiter als „dokumentiert“",
      ).toBe(0);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);

  it("AC-3 – die Zähl-Richtung bleibt: was der Reader zählt, erscheint auch", async () => {
    /**
     * Der Gegenfall zu AC-1/AC-2, und er ist Pflicht: ein Fix, der die
     * Aufteilung einfach leert, erfüllte beide oberen Fälle. Diese Buchung
     * liegt in JEDEM Fenster — kein Ausschluss-Glied greift.
     */
    const id = await kunde();
    try {
      const [ue] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: UEBERTRAG, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-12-31`, notes: "AC3-uebertrag-gueltig",
      }).returning({ id: budgetAllocations.id });

      const termin = await dokumentierterTermin(id, `${J}-07-10`);
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -BETRAG, transactionDate: `${J}-07-10`,
        allocationId: ue.id, appointmentId: termin,
        description: "AC3-zaehlt-regulaer",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-08-15`);
      const uni = await readUnifiedBudgetAvailability(id, `${J}-08-15`);

      expect(
        uni.pots.entlastungsbetrag_45b.consumedNetCents,
        "Vorbedingung verletzt — der Reader zählt die reguläre Buchung nicht",
      ).toBe(BETRAG);

      for (const topf of fifo.pots) pruefeAufteilung(topf);
      const carry = fifo.pots.find(p => p.potType === "carryover")!;
      expect(
        carry.consumedDocumentedCents,
        "ein regulär gezählter dokumentierter Termin erscheint nicht als "
        + "„dokumentiert“ — der Fix zählt nur noch nach unten",
      ).toBe(BETRAG);
      expect(carry.consumedCents).toBe(BETRAG);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
  it("AC-4 – Glied (a) unter Flag an: Verbrauch gegen einen vom Startwert ERSETZTEN Übertrag", async () => {
    /**
     * Gate 2 zu #192, S-2. AC-1 prüft Glied (a) nur über einen ABGELAUFENEN
     * Übertrag — dort ist das Flag egal. Der Fall, den der unmittelbar
     * folgende Default-Umschwung auslöst, fehlte: ein vom Startwert
     * VERDRÄNGTER Übertrag, gegen den nach dem Cutoff gebucht wurde (so bucht
     * die Engine: Übertrag zuerst, und verknüpft die Buchung mit ihm).
     *
     * Zugesichert ist hier die ÜBEREINSTIMMUNG mit dem Reader, nicht ein
     * bestimmter Betrag: ob dieser Verbrauch zählen MUSS, entscheidet R4 und
     * regelt der Flip-PR. Diese Datei sichert, dass die Aufteilung dem
     * Reader folgt, egal wie er entscheidet.
     */
    const id = await kunde();
    try {
      const [ue] = await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: null,
        amountCents: UEBERTRAG, source: "carryover",
        validFrom: `${J}-01-01`, expiresAt: `${J}-06-30`, notes: "AC4-uebertrag-verdraengt",
      }).returning({ id: budgetAllocations.id });
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: J, month: 3,
        amountCents: 300_00, source: "initial_balance",
        validFrom: `${J}-03-01`, expiresAt: null, notes: "AC4-startwert-maerz",
      });

      const termin = await dokumentierterTermin(id, `${J}-04-10`);
      await db.insert(budgetTransactions).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", transactionType: "consumption",
        amountCents: -BETRAG, transactionDate: `${J}-04-10`,
        allocationId: ue.id, appointmentId: termin,
        description: "AC4-nach-cutoff-auf-verdraengtem-uebertrag",
      } as never);

      const fifo = await readBudget45bFifoBreakdown(id, `${J}-05-15`, { resetDisplacesAllSources: true });
      const uni = await readUnifiedBudgetAvailability(id, `${J}-05-15`, undefined, { resetDisplacesAllSources: true });

      for (const topf of fifo.pots) pruefeAufteilung(topf);
      expect(
        fifo.pots.reduce((n, p) => n + p.consumedCents, 0),
        "Aufteilung und Reader sehen unter Flag an verschiedene Verbrauchs-Mengen",
      ).toBe(uni.pots.entlastungsbetrag_45b.consumedNetCents);
    } finally {
      await cleanupCustomer(id);
    }
  }, 120_000);
});
