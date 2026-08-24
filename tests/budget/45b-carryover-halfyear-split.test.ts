import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  syncCarryoverAndExpiry,
  calculateAllocatedCents,
} from "../../server/storage/budget/allocation-storage";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";

/**
 * §45b-Übertrag — halbjahresscharfe Verrechnung (Cluster 6h8v99QX/6hH8p26G).
 *
 * ── Was hier gemessen wird ───────────────────────────────────────────────
 * `ensureYearlyCarryover45b` verrechnete den hereingerollten Übertrag gegen den
 * Verbrauch OHNE Datums-Unterscheidung:
 *
 *     consumedAgainstOwnYear = max(0, netConsumed − totalCarryoverIn)
 *
 * Der Übertrag verfällt aber zum 30.06. Ein Verbrauch im August konnte damit
 * von einem Guthaben absorbiert werden, das es seit sechs Wochen nicht mehr
 * gab — der eigene Jahrestopf blieb unbelastet, der Folge-Übertrag zu groß, die
 * Verfügbarkeit zu hoch. Fehlerrichtung immer permissiv (Überziehung gegen die
 * Kassen).
 *
 * ── Warum diese Fixtures und nicht der Normalfall ────────────────────────
 * Im eingeschwungenen Zustand kaschierte die alte Formel ihren eigenen Fehler:
 * sie zählte den Verfalls-`write_off` als Verbrauch mit, und der entspricht
 * gerade dem nicht aufgezehrten Teil des Übertrags — `netConsumed −
 * totalCarryoverIn` kam dadurch näherungsweise aufs richtige Ergebnis. Die
 * Kompensation trägt nur, solange `processExpiredCarryover` bereits gelaufen
 * ist UND der Write-Off exakt den Rest abbildet.
 *
 * Beide Fixtures unten sind so gebaut, dass sie NICHT trägt — mit einem
 * Übertrag ohne `expires_at`. Der ist nicht konstruiert: `processExpiredCarryover`
 * filtert auf `expiresAt IS NOT NULL`, solche Zeilen bekommen also nie einen
 * Write-Off und leben unbegrenzt weiter. Genau diese Population zählt die
 * Gate-1-Messung als eigenen Befund.
 *
 * ── Kein zweiter Rechenweg im Test ───────────────────────────────────────
 * Der Jahresanspruch wird NICHT nachgerechnet, sondern über
 * `calculateAllocatedCents({ year })` aus der Produktion gelesen — dieselbe
 * Quelle, die auch der Schreibpfad benutzt. Behauptet wird hier ausschließlich
 * etwas über die ABSORPTION, nicht über die Anspruchs-Mathematik.
 */

const curYear = new Date().getFullYear();
/** Quelljahr des Rolls. Muss < curYear sein, sonst überspringt ihn `yearsToProcess`. */
const quellJahr = curYear - 1;
/** Frist des Übertrags, der IN das Quelljahr rollte. */
const fristImQuellJahr = `${quellJahr}-06-30`;

const VERBRAUCH_CENTS = 300_00;
const UEBERTRAG_IN_CENTS = 500_00;
const STARTWERT_CENTS = 100_00;

/**
 * Kunde mit §45b, dessen Anker über den STARTWERT läuft — nicht über den
 * Pflegegrad.
 *
 * Der Pflegegrad-Anker wird auf den 01.01. des LAUFENDEN Jahres gebodet
 * (`floorAutoAnchor45bToCurrentYear`). Bliebe die Historie stehen, läge
 * `eligibilityStartYear` bei `curYear` und `yearsToProcess` wäre leer — der
 * Test liefe grün, ohne je einen Roll auszulösen.
 */
async function kundeMitStartwert(): Promise<number> {
  const c = await createTestCustomer({
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;

  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));

  await upsertBudgetTypeSettings(id, [{
    budgetType: "entlastungsbetrag_45b",
    enabled: true,
    priority: 1,
    monthlyLimitCents: null,
    yearlyLimitCents: null,
    validFrom: null,
    validTo: null,
  }]);

  await db.insert(budgetAllocations).values({
    customerId: id,
    budgetType: "entlastungsbetrag_45b",
    year: quellJahr,
    month: 1,
    amountCents: STARTWERT_CENTS,
    source: "initial_balance",
    validFrom: `${quellJahr}-01-01`,
    expiresAt: null,
    notes: "HJ-Test Startwert (Anker)",
  });

  return id;
}

async function uebertragAnlegen(row: {
  customerId: number; year: number; validFrom: string; expiresAt: string | null;
}): Promise<void> {
  await db.insert(budgetAllocations).values({
    customerId: row.customerId,
    budgetType: "entlastungsbetrag_45b",
    year: row.year,
    month: null,
    amountCents: UEBERTRAG_IN_CENTS,
    source: "carryover",
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    notes: "HJ-Test hereingerollter Übertrag",
  });
}

/** Verbrauch auf dem NULL-Leg (Monatsaufstockung), wie die FIFO-Buchung ihn schreibt. */
async function verbrauchAnlegen(customerId: number, datum: string): Promise<void> {
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    transactionDate: datum,
    transactionType: "consumption",
    amountCents: -VERBRAUCH_CENTS,
    allocationId: null,
    notes: "HJ-Test Verbrauch",
  });
}

/** Der ins Folgejahr gerollte Übertrag, über das FENSTER gesucht. */
async function gerollterUebertragCents(customerId: number): Promise<number> {
  const rows = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    eq(budgetAllocations.validFrom, `${curYear}-01-01`),
    isNull(budgetAllocations.deletedAt),
  ));
  return rows.reduce((s, a) => s + a.amountCents, 0);
}

describe("§45b-Übertrag — halbjahresscharfe Verrechnung", () => {
  it("HJ-1 – Verbrauch NACH der Frist wird nicht mehr vom verfallenen Übertrag absorbiert", async () => {
    const id = await kundeMitStartwert();
    try {
      await uebertragAnlegen({
        customerId: id, year: quellJahr,
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
      });
      await verbrauchAnlegen(id, `${quellJahr}-08-15`);

      const anspruch = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { year: quellJahr },
      );
      expect(anspruch, "Vorbedingung: ohne Jahresanspruch misst der Test nichts")
        .toBeGreaterThan(VERBRAUCH_CENTS);

      await syncCarryoverAndExpiry(id);

      // Der Verbrauch lag NACH dem 30.06. — der hereingerollte Übertrag war da
      // schon tot und darf ihn nicht mehr decken. Er belastet den eigenen
      // Jahrestopf.
      //
      // Die alte, jahresscharfe Formel lieferte hier
      // `max(0, 300 − 500) = 0` an belastetem Eigenanteil und rollte den
      // VOLLEN Jahresanspruch weiter — 300,00 € zu viel.
      expect(
        await gerollterUebertragCents(id),
        "Verbrauch nach dem 30.06. muss den eigenen Jahrestopf belasten, nicht den verfallenen Übertrag",
      ).toBe(anspruch - VERBRAUCH_CENTS);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("HJ-2 – Verbrauch VOR der Frist wird weiterhin absorbiert (keine Über-Korrektur)", async () => {
    const id = await kundeMitStartwert();
    try {
      await uebertragAnlegen({
        customerId: id, year: quellJahr,
        validFrom: `${quellJahr}-01-01`, expiresAt: null,
      });
      await verbrauchAnlegen(id, `${quellJahr}-03-15`);

      const anspruch = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { year: quellJahr },
      );

      await syncCarryoverAndExpiry(id);

      // Gegenrichtung zu HJ-1, und der Grund, warum der Fix ein SPLIT ist und
      // keine pauschale Verschärfung: bis zum 30.06. lebte der Übertrag, der
      // Verbrauch geht rechtmäßig gegen ihn. Der eigene Jahrestopf bleibt
      // unbelastet, der volle Anspruch rollt weiter.
      expect(
        await gerollterUebertragCents(id),
        "Verbrauch vor dem 30.06. muss weiter vom Übertrag gedeckt werden",
      ).toBe(anspruch);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("HJ-3 – Legacy-Zeile (`year` = Quelljahr) rollt nach ihrem FENSTER, nicht nach der Spalte", async () => {
    const id = await kundeMitStartwert();
    try {
      // Wizard-Konvention vor #601: `year` trägt das QUELLjahr, `valid_from`
      // aber (wie immer) den 01.01. des ZIELjahres. Auf Prod tragen 26 Zeilen
      // diese Konvention.
      //
      // Diese Zeile rollte in `curYear` — sie ist für den Roll des QUELLJAHRES
      // gar kein Zufluss. Die `year`-Zuordnung hielt sie fälschlich für einen
      // und ließ sie dort Verbrauch absorbieren, den sie nie decken konnte.
      await uebertragAnlegen({
        customerId: id, year: quellJahr,
        validFrom: `${curYear}-01-01`, expiresAt: null,
      });
      await verbrauchAnlegen(id, `${quellJahr}-03-15`);

      const anspruch = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { year: quellJahr },
      );

      await syncCarryoverAndExpiry(id);

      const gerollt = await gerollterUebertragCents(id);
      // Erwartung: KEIN Zufluss im Quelljahr ⇒ der Verbrauch belastet den
      // eigenen Topf, obwohl er vor dem 30.06. lag. Unter `year`-Zuordnung
      // wäre er absorbiert worden und der volle Anspruch weitergerollt.
      //
      // `gerollt` enthält die Legacy-Zeile selbst mit (gleiches Fenster) —
      // deshalb wird sie hier herausgerechnet, statt den Vergleichswert
      // aufzublähen.
      expect(
        gerollt - UEBERTRAG_IN_CENTS,
        "Eine Zeile mit `valid_from` im Folgejahr ist im Quelljahr kein Zufluss",
      ).toBe(anspruch - VERBRAUCH_CENTS);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
