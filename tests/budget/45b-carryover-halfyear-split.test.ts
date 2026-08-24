import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  syncCarryoverAndExpiry,
  processExpiredCarryover,
  calculateAllocatedCents,
} from "../../server/storage/budget/allocation-storage";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";

/**
 * §45b-Übertrag — Absorption aus dem LEDGER (Cluster 6h8v99QX/6hH8p26G).
 *
 * ── Die Invariante, um die es geht ───────────────────────────────────────
 *
 *     Roll = Jahresanspruch + Übertrag-hinein − Verbrauch − Write-Off
 *
 * `ensureYearlyCarryover45b` verrechnete den hereingerollten Übertrag über
 * seinen BETRAG (`netConsumed − totalCarryoverIn`) statt über das, was er laut
 * Buchung getragen hat. Solange `processExpiredCarryover` schon gelaufen war,
 * glich der mitgezählte Write-Off das aus; davor fehlte der Ausgleich, der
 * eigene Jahrestopf wurde zu wenig belastet und ein zu hoher Übertrag
 * persistiert → Verfügbarkeit zu hoch → höhere §45b-Forderung an die Kasse.
 *
 * ── Warum LEDGER und nicht Datum ─────────────────────────────────────────
 * Eine datumsbasierte Absorption („alles bis zum 30.06.") war die erste
 * Fassung dieses PR und im Gate-2 messbar falsch: der Verfalls-Write-Off
 * bestimmt den ungenutzten Rest über die VERLINKUNG, und wo Datum und
 * Verlinkung auseinanderliefen, galten dieselben Cent zweimal als gedeckt.
 * LH-3 unten ist genau dieser Fall und war der Beleg.
 *
 * Die 30.06.-Frist ist damit nicht aufgegeben, sondern dort durchgesetzt, wo
 * sie hingehört: `computeFifoAvailability` nimmt eine Übertrags-Allocation nur
 * in die FIFO-Kette auf, solange `expiresAt >= transactionDate`. Eine Buchung
 * nach der Frist kann per Konstruktion nicht auf sie zeigen.
 *
 * ── Kein zweiter Rechenweg im Test ───────────────────────────────────────
 * Der Jahresanspruch wird über `calculateAllocatedCents({ year })` aus der
 * Produktion gelesen. Behauptet wird hier ausschließlich etwas über die
 * ABSORPTION, nicht über die Anspruchs-Mathematik.
 */

const curYear = new Date().getFullYear();
/** Quelljahr des Rolls. Muss < curYear sein, sonst überspringt ihn `yearsToProcess`. */
const quellJahr = curYear - 1;
const FRIST = `${quellJahr}-06-30`;

const VERBRAUCH = 300_00;
const UEBERTRAG_IN = 500_00;
const STARTWERT = 100_00;

/**
 * Kunde mit §45b, dessen Anker über den STARTWERT läuft — nicht über den
 * Pflegegrad. Der Pflegegrad-Anker wird auf den 01.01. des LAUFENDEN Jahres
 * gebodet; bliebe die Historie stehen, wäre `yearsToProcess` leer und der Test
 * liefe grün, ohne je einen Roll auszulösen.
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
    enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null,
    validFrom: null, validTo: null,
  }]);
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    year: quellJahr, month: 1, amountCents: STARTWERT, source: "initial_balance",
    validFrom: `${quellJahr}-01-01`, expiresAt: null, notes: "LH-Test Anker",
  });
  return id;
}

async function uebertragAnlegen(
  customerId: number,
  opts: { year?: number; validFrom?: string; expiresAt: string | null },
): Promise<number> {
  const [row] = await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b",
    year: opts.year ?? quellJahr, month: null, amountCents: UEBERTRAG_IN, source: "carryover",
    validFrom: opts.validFrom ?? `${quellJahr}-01-01`, expiresAt: opts.expiresAt,
    notes: "LH-Test hereingerollter Übertrag",
  }).returning();
  return row.id;
}

async function verbrauchAnlegen(
  customerId: number, datum: string, allocationId: number | null,
): Promise<void> {
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "entlastungsbetrag_45b",
    transactionDate: datum, transactionType: "consumption",
    amountCents: -VERBRAUCH, allocationId, notes: "LH-Test Verbrauch",
  });
}

async function gerollt(customerId: number): Promise<number> {
  const rows = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    eq(budgetAllocations.validFrom, `${curYear}-01-01`),
    isNull(budgetAllocations.deletedAt),
  ));
  return rows.reduce((s, a) => s + a.amountCents, 0);
}

async function writeOffCents(customerId: number): Promise<number> {
  const rows = await db.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
    eq(budgetTransactions.transactionType, "write_off"),
  ));
  return rows.reduce((s, t) => s + Math.abs(t.amountCents), 0);
}

describe("§45b-Übertrag — Absorption aus dem Ledger", () => {
  it("LH-1 – Verbrauch, der NICHT gegen den Übertrag gebucht ist, belastet den eigenen Topf", async () => {
    const id = await kundeMitStartwert();
    try {
      await uebertragAnlegen(id, { expiresAt: FRIST });
      // Nach der Frist gebucht — die FIFO-Buchung konnte nicht verlinken.
      await verbrauchAnlegen(id, `${quellJahr}-08-15`, null);

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });
      expect(anspruch, "Vorbedingung: ohne Jahresanspruch misst der Test nichts").toBeGreaterThan(VERBRAUCH);

      await syncCarryoverAndExpiry(id);

      // Ledger-Invariante: Anspruch + CarryIn − Verbrauch − WriteOff.
      expect(await gerollt(id)).toBe(anspruch + UEBERTRAG_IN - VERBRAUCH - await writeOffCents(id));
      expect(await gerollt(id), "alte Formel rollte hier den vollen Anspruch").toBe(anspruch - VERBRAUCH);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("LH-2 – Verbrauch, der GEGEN den Übertrag gebucht ist, zehrt ihn auf", async () => {
    const id = await kundeMitStartwert();
    try {
      const carryId = await uebertragAnlegen(id, { expiresAt: FRIST });
      // Vor der Frist gebucht und verlinkt — genau das tut die FIFO-Buchung.
      await verbrauchAnlegen(id, `${quellJahr}-03-15`, carryId);

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });

      await syncCarryoverAndExpiry(id);

      // Gegenrichtung zu LH-1: der eigene Topf bleibt unbelastet, der volle
      // Anspruch rollt weiter. Ohne diesen Fall wäre der Fix eine pauschale
      // Verschärfung statt einer Zuordnung.
      expect(await gerollt(id)).toBe(anspruch + UEBERTRAG_IN - VERBRAUCH - await writeOffCents(id));
      expect(await gerollt(id)).toBe(anspruch);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("LH-3 – B1: Vor-Frist-Verbrauch OHNE Verlinkung + vorhandener Write-Off bleibt ledger-exakt", async () => {
    // DER Gate-2-Blocker. Die datumsbasierte Fassung dieses PR rollte hier
    // 154.100 statt 124.100 — 300,00 € zu viel, permissive Richtung.
    //
    // Konstellation: der Übertrag verfiel ungenutzt (voller Write-Off), der
    // Verbrauch lag zwar VOR der Frist, hing aber nicht an ihm. Eine
    // Datumsregel hätte ihn als absorbiert gerechnet, während der Write-Off
    // dieselben Cent bereits als verfallen auswies — doppelt gedeckt.
    //
    // Erreichbar u.a. so: der Übertrag wird per Wizard angelegt, NACHDEM im
    // 1. Halbjahr schon gebucht wurde; oder eine Duplikat-Zeile wird
    // soft-gelöscht und ihr Verbrauch ist von der behaltenen aus unsichtbar.
    const id = await kundeMitStartwert();
    try {
      await uebertragAnlegen(id, { expiresAt: FRIST });
      await verbrauchAnlegen(id, `${quellJahr}-03-15`, null);

      // Steady State erzwingen: der Write-Off existiert, bevor gerollt wird.
      await processExpiredCarryover(id);
      const wo = await writeOffCents(id);
      expect(wo, "Vorbedingung: ohne Write-Off misst dieser Test die Klasse nicht").toBe(UEBERTRAG_IN);

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });

      await syncCarryoverAndExpiry(id);

      expect(
        await gerollt(id),
        "Ledger-Invariante: Anspruch + CarryIn − Verbrauch − WriteOff",
      ).toBe(anspruch + UEBERTRAG_IN - VERBRAUCH - wo);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("LH-4 – Reihenfolge: der Verfall wird VOR der Anlage geschrieben", async () => {
    // Die zweite Ursachen-Hälfte, unabhängig von der Formel. Lief die Anlage
    // zuerst, las sie den Verbrauchsstand des Quelljahres, bevor der Übertrag
    // seinen Write-Off hatte — die betrags-basierte Verrechnung hing genau
    // daran. Gemessen wird die WIRKUNG, nicht die Aufrufreihenfolge: nach
    // EINEM Sync (ohne vorherigen `processExpiredCarryover`-Aufruf) muss der
    // Write-Off da sein und das Ergebnis identisch zu LH-3.
    const id = await kundeMitStartwert();
    try {
      await uebertragAnlegen(id, { expiresAt: FRIST });
      await verbrauchAnlegen(id, `${quellJahr}-03-15`, null);

      const anspruch = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });

      await syncCarryoverAndExpiry(id);

      expect(
        await writeOffCents(id),
        "Der Verfall des hereingerollten Übertrags muss im SELBEN Sync geschrieben sein",
      ).toBe(UEBERTRAG_IN);
      expect(await gerollt(id)).toBe(anspruch + UEBERTRAG_IN - VERBRAUCH - UEBERTRAG_IN);
    } finally {
      await cleanupCustomer(id);
    }
  });

});
