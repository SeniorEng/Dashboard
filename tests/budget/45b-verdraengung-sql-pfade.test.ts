import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer, getAuthCookie } from "../test-utils";
import { getTotalCarryoverCents } from "../../server/storage/budget/summary-queries";
import { readBudget45bFifoBreakdown } from "../../server/storage/budget/fifo-breakdown";

/**
 * P1 `6hXp9qMrXH2WGVVG`, Vorbedingung 1 — die fünf SQL-Pfade kennen die
 * Verdrängung nicht.
 *
 * ── Die Naht, an der es auseinanderfällt ────────────────────────────────
 * `readBudget45bFifoBreakdown` rechnet `allocatedCur = A − allocatedCarry`.
 *
 *   A              kommt aus `calculateAllocated45b` — kennt die Verdrängung
 *   allocatedCarry kommt aus handgeschriebenem SQL — kennt sie NICHT
 *
 * #166 hat alle fünf SQL-Stellen auf `allocationValidAtWhere` gezogen. Das
 * vereinheitlicht das ZEITFENSTER; die Verdrängung ist dort nicht enthalten
 * (`displacedByReset` hat keine Drizzle-Entsprechung). Solange das Flag aus
 * ist, sind beide Seiten deckungsgleich und nichts fällt auf.
 *
 * ── Warum das der gefährlichste der vier Punkte ist ─────────────────────
 * Ein negativer Topf ist im Client nicht zu sehen: er wird über
 * `p.allocatedCents > 0` weggefiltert. Der Fehler äußert sich also nicht als
 * falsche Zahl, sondern als FEHLENDE Zeile — und eine fehlende Zeile sieht
 * aus wie „kein Übertrag vorhanden", nicht wie ein Rechenfehler.
 *
 * Die Zusage steht deshalb auf der Differenz selbst, nicht auf der Anzeige:
 * gemessen wird, was die beiden Quellen liefern, die voneinander abgezogen
 * werden.
 */

const JAHR = 2026;
const STARTWERT_MONAT = 6;
const STICHTAG = `${JAHR}-06-15`;

/** Alriks Zahlen aus dem Stammticket (#1915, Kunde 89). */
const STARTWERT_CENTS = 131_00;
const UEBERTRAG_CENTS = 1_179_00;

async function kundeMitStartwertUndUebertrag(): Promise<number> {
  await getAuthCookie();
  const c = await createTestCustomer({
    pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
  });
  await db.insert(budgetAllocations).values([
    {
      // Der Übertrag aus dem Vorjahr — beginnt VOR dem Startwert und ist zum
      // Stichtag noch nicht verfallen. Genau die Lage aus dem Stammticket.
      customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
      amountCents: UEBERTRAG_CENTS, source: "carryover",
      validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "SQ-Uebertrag",
    },
    {
      // Die Inventur: „ab Juni gilt dieser Bestand."
      customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: STARTWERT_MONAT,
      amountCents: STARTWERT_CENTS, source: "initial_balance",
      validFrom: `${JAHR}-${String(STARTWERT_MONAT).padStart(2, "0")}-01`,
      expiresAt: null, notes: "SQ-Startwert",
    },
  ]);
  return id;
}

describe("§45b-Verdrängung — Anspruch und Übertrags-Summe aus derselben Regel", () => {
  it("SQ-1 – mit scharfer Verdrängung bleibt kein Topf negativ", async () => {
    /**
     * Die Zusage steht auf dem, was der Aufrufer BEKOMMT — nicht auf einer
     * nachgebauten Subtraktion.
     *
     * Die erste Fassung rechnete `calculateAllocatedCents(flag) −
     * getTotalCarryoverCents(ohne Flag)` von Hand nach. Das reproduzierte den
     * Fehler zwar (−1.048,00 €), war aber selbst ein Zweitbegriff: der Test
     * behauptete etwas über `readBudget45bFifoBreakdown` und maß eine
     * Formel, die er sich daneben selbst gebaut hatte. Wäre die echte Formel
     * später anders geworden, hätte der Test weiter grün das Falsche geprüft.
     *
     * Jetzt läuft er durch die Funktion selbst.
     */
    const id = await kundeMitStartwertUndUebertrag();
    try {
      const breakdown = await readBudget45bFifoBreakdown(id, STICHTAG, {
        resetDisplacesAllSources: true,
      });

      const negativ = breakdown.pots.filter(p => p.allocatedCents < 0);
      expect(
        negativ.map(p => `${p.potType}=${(p.allocatedCents / 100).toFixed(2)} €`),
        "ein Topf ist negativ — der Client filtert ihn über `p.allocatedCents > 0` "
        + "still weg, der Fehler zeigt sich dann als FEHLENDE Zeile",
      ).toEqual([]);

      // Und die Gegenrichtung: die Summe der Töpfe ist der Anspruch. Ohne sie
      // wäre „kein Topf negativ" auch dadurch zu erfüllen, dass beide 0 sind.
      const summe = breakdown.pots.reduce((s, p) => s + p.allocatedCents, 0);
      expect(summe, "Topf-Summe und Gesamtanspruch laufen auseinander")
        .toBe(breakdown.totalAllocatedCents);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("SQ-2 – der verdrängte Übertrag zählt in der Übertrags-Summe nicht mehr mit", async () => {
    // Die positive Formulierung derselben Sache. SQ-1 sichert nur, dass nichts
    // negativ wird — das ließe sich auch erreichen, indem der Anspruch steigt.
    // Hier steht, WELCHE der beiden Seiten sich bewegen muss.
    const id = await kundeMitStartwertUndUebertrag();
    try {
      const ohne = await getTotalCarryoverCents(id, STICHTAG);
      const mit = await getTotalCarryoverCents(id, STICHTAG, undefined, {
        resetDisplacesAllSources: true,
      });

      expect(ohne, "ohne Flag zählt der Übertrag unverändert mit").toBe(UEBERTRAG_CENTS);
      expect(
        mit,
        "mit Flag zählt der vom Startwert ersetzte Übertrag weiterhin mit",
      ).toBe(0);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("SQ-4 – die Verdrängung trifft den Übertrag, nicht den Startwert selbst", async () => {
    /**
     * Die Quellen-Grenze in `notDisplacedByResetWhere`.
     *
     * Der Startwert erfüllt die Verdrängungs-Bedingung wörtlich: sein
     * `validFrom` IST `cutoffDate`, sein `year` IST `reset.year`. Ohne die
     * Grenze `source <> 'carryover'` löscht die Inventur sich selbst.
     *
     * ── Warum dieser Test hier steht und nicht weggelassen werden kann ────
     * Vier der fünf SQL-Stellen filtern ohnehin auf `source = 'carryover'`;
     * dort ist die Grenze wirkungslos. Sie wirkt genau in der
     * consumption-engine, die `carryover`, `initial_balance` und
     * `manual_adjustment` zusammen lädt — also im BUCHUNGS-Pfad.
     *
     * Im Mutations-Gegencheck blieben SQ-1 bis SQ-3 **grün**, als die Grenze
     * entfernt wurde. Die Zusage „nur der Übertrag wird verdrängt" war also
     * durch nichts belegt.
     */
    const id = await kundeMitStartwertUndUebertrag();
    try {
      const { computeFifoAvailability } = await import(
        "../../server/storage/budget/consumption-engine"
      );
      const fifo = await computeFifoAvailability(
        id, "entlastungsbetrag_45b", STICHTAG, undefined,
        { resetDisplacesAllSources: true },
      );

      const betraege = fifo.specialAllocations.map(a => a.amountCents);
      expect(
        betraege,
        "der Startwert wurde mitverdrängt — die Inventur löscht sich selbst",
      ).toContain(STARTWERT_CENTS);
      expect(
        betraege,
        "der vom Startwert ersetzte Übertrag steht der Buchung weiter zur Verfügung",
      ).not.toContain(UEBERTRAG_CENTS);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("SQ-3 – ohne Startwert bleibt der Übertrag unangetastet", async () => {
    // Gegenprobe: aus „verdrängt zu selten" darf kein „verdrängt immer" werden.
    await getAuthCookie();
    const c = await createTestCustomer({
      pflegegrad: 3, billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
    });
    const id = c.id as number;
    try {
      await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
      await db.insert(customerBudgetTypeSettings).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1,
        monthlyLimitCents: null, yearlyLimitCents: null, validFrom: `${JAHR}-01-01`, validTo: null,
      });
      await db.insert(budgetAllocations).values({
        customerId: id, budgetType: "entlastungsbetrag_45b", year: JAHR, month: null,
        amountCents: UEBERTRAG_CENTS, source: "carryover",
        validFrom: `${JAHR}-01-01`, expiresAt: `${JAHR}-06-30`, notes: "SQ3-Uebertrag",
      });

      const mit = await getTotalCarryoverCents(id, STICHTAG, undefined, {
        resetDisplacesAllSources: true,
      });
      expect(mit, "ohne Startwert wurde der Übertrag trotzdem verdrängt").toBe(UEBERTRAG_CENTS);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
