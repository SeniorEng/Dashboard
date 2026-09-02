import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, customerBudgetTypeSettings, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  calculateAllocatedCents,
  planCarryoverRolls45b,
  syncCarryoverAndExpiry,
} from "../../server/storage/budget/allocation-storage";

/**
 * §45b — der `{year}`-Pool darf nicht an einer späteren Übertragszeile hängen.
 *
 * ── Der Defekt (Ticket 6hQGvwCFvvMC7j6G, P1) ─────────────────────────────
 * `carryoverCounted` zog `allocStart` auf das Zieljahr der spätesten gültigen
 * Übertragszeile — auch im `{year}`-Pool-Modus. Eine `curYear`-Übertragszeile
 * schob den Start damit auf den 01.01. des laufenden Jahres, und die
 * Monatsaufstockungen ALLER früheren Jahre fielen aus dem Pool. Übrig blieb nur
 * `sumInitialBalancesForYear`, das getrennt läuft.
 *
 * Folge: `ensureYearlyCarryover45b` fand für das Quelljahr nichts mehr zu
 * rollen — die Anker-Erweiterung aus #132 war für diese Kunden stillschweigend
 * wirkungslos. Auf Prod: 97 von 163 aktiven §45b-Kunden (59,5 %, Messung
 * 02.09.2026).
 *
 * Der Shift gehört zur AS-OF-Frage („was ist heute verfügbar?"), wo er eine
 * Doppelzählung verhindert. Im `{year}`-Modus wird eine andere Frage gestellt,
 * und der Rückgabezweig addiert `carryoverTotal` dort gar nicht — es gibt also
 * nichts, was doppelt zählen könnte. Der Verfalls-Boden direkt darunter ist aus
 * demselben Grund längst mit `opts.year == null` gegatet; diese Klammer fehlte
 * nur beim Shift.
 */

const curYear = new Date().getFullYear();
const quellJahr = curYear - 1;

async function kundeMitStartwert(ankerJahr: number = quellJahr): Promise<number> {
  const c = await createTestCustomer({
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  const id = c.id as number;
  // Ohne Pflegegrad-Historie: der PG-Anker würde auf den 01.01. des LAUFENDEN
  // Jahres gebodet und gäbe nie ein Quelljahr frei.
  await db.delete(customerCareLevelHistory).where(eq(customerCareLevelHistory.customerId, id));
  await db.insert(customerBudgetTypeSettings).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    enabled: true, priority: 1,
    monthlyLimitCents: null, yearlyLimitCents: null,
    validFrom: `${ankerJahr}-01-01`, validTo: null,
  });
  await db.insert(budgetAllocations).values({
    customerId: id, budgetType: "entlastungsbetrag_45b",
    year: ankerJahr, month: 1, amountCents: 100_00, source: "initial_balance",
    validFrom: `${ankerJahr}-01-01`, expiresAt: null, notes: "YP-Anker",
  });
  return id;
}

async function curYearUebertrag(customerId: number, amountCents = 500_00): Promise<void> {
  await db.insert(budgetAllocations).values({
    customerId, budgetType: "entlastungsbetrag_45b",
    year: curYear, month: null, amountCents, source: "carryover",
    validFrom: `${curYear}-01-01`, expiresAt: `${curYear}-06-30`,
    notes: "YP curYear-Uebertrag",
  });
}

async function uebertragsZeilen(customerId: number): Promise<string[]> {
  const rows = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
  ));
  return rows.map(a => `${a.validFrom}:${a.amountCents}`).sort();
}

describe("§45b {year}-Pool — Übertrags-Shift gehört nicht in den Pool-Modus", () => {
  it("YP-1 – eine curYear-Übertragszeile lässt den Quelljahres-Anspruch unberührt", async () => {
    const id = await kundeMitStartwert();
    try {
      const ohne = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });
      expect(ohne, "Vorbedingung: ohne Anspruch misst der Test nichts").toBeGreaterThan(100_00);

      await curYearUebertrag(id);
      const mit = await calculateAllocatedCents(id, "entlastungsbetrag_45b", { year: quellJahr });

      // Vor dem Fix: 154.100 -> 10.000 (nur der Startwert überlebte).
      expect(
        mit,
        "Der Anspruch des Quelljahres darf nicht davon abhängen, ob für ein " +
          "SPÄTERES Jahr eine Übertragszeile existiert",
      ).toBe(ohne);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("YP-2 – mit curYear-Übertragszeile entstehen die Rolls der FRÜHEREN Jahre", async () => {
    // Die fachliche Wirkung — und ihre GRENZE, die ich beim ersten Anlauf
    // falsch angesetzt hatte:
    //
    // Für das unmittelbare Quelljahr (curYear-1 → curYear) greift der Dedup
    // völlig zu Recht: die Zieljahres-Zeile existiert ja bereits, das ist die
    // Definition der betroffenen Gruppe. Der Fix wirkt für die Jahre DAVOR,
    // deren Zieljahre noch keine Zeile haben — und genau die fielen vorher
    // still aus, weil der Pool für sie 0 lieferte.
    //
    // Deshalb ein Anker drei Jahre zurück. Mit Anker nur bei curYear-1 ändert
    // der Fix nichts, und ein Test darauf hätte eine Wirkung behauptet, die es
    // dort nicht gibt.
    const ankerJahr = curYear - 3;
    const id = await kundeMitStartwert(ankerJahr);
    try {
      await curYearUebertrag(id);
      await syncCarryoverAndExpiry(id);

      const zeilen = await uebertragsZeilen(id);
      const zieljahre = zeilen.map(z => z.slice(0, 4)).sort();

      // Erwartet: Rolls für ankerJahr→+1 und +1→+2, plus die vorhandene
      // curYear-Zeile. NICHT für curYear-1→curYear (Dedup).
      expect(
        zieljahre,
        "die Jahre vor curYear-1 müssen jetzt rollen; curYear bleibt beim Bestand",
      ).toEqual([String(ankerJahr + 1), String(ankerJahr + 2), String(curYear)]);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("YP-3 – die AS-OF-Sicht behält ihren Shift (kein Kollateralschaden)", async () => {
    // Gegenrichtung: der Shift ist im as-of-Modus RICHTIG — dort verhindert er
    // die Doppelzählung von Jahren, die der Übertrag bereits kondensiert. Wäre
    // er versehentlich ganz entfernt worden, stiege die Verfügbarkeit; genau
    // die permissive Richtung, gegen die dieser Cluster antritt.
    const id = await kundeMitStartwert();
    try {
      await curYearUebertrag(id);
      const asOf = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { asOfDate: `${curYear}-03-15` },
      );
      const poolQuelljahr = await calculateAllocatedCents(
        id, "entlastungsbetrag_45b", { year: quellJahr },
      );

      // Die as-of-Sicht zählt das Quelljahr NICHT mit (der Übertrag kondensiert
      // es); der Pool-Modus schon. Beide Zahlen dürfen deshalb nicht gleich sein.
      expect(
        asOf,
        "as-of darf den Quelljahres-Anspruch nicht zusätzlich aufschlagen",
      ).toBeLessThan(poolQuelljahr + 500_00);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("YP-4 – Plan und Ausführung sind deckungsgleich (die Dry-Run-Naht trägt)", async () => {
    // Der Dry-Run zählt, was `planCarryoverRolls45b` liefert. Wäre der Plan
    // etwas anderes als das, was `ensureYearlyCarryover45b` schreibt, zählte er
    // an der Wirklichkeit vorbei — und die Auflage aus dem Ticket wäre eine
    // Zahl ohne Deckung.
    const id = await kundeMitStartwert(curYear - 3);
    try {
      await curYearUebertrag(id);

      const plan = await planCarryoverRolls45b(id);
      expect(plan.length, "Vorbedingung: der Plan muss etwas enthalten").toBeGreaterThan(0);

      const vorher = await uebertragsZeilen(id);
      await syncCarryoverAndExpiry(id);
      const nachher = await uebertragsZeilen(id);

      const entstanden = nachher.filter(z => !vorher.includes(z)).sort();
      const geplant = plan.map(p => `${p.validFrom}:${p.amountCents}`).sort();
      expect(entstanden, "geschriebene Zeilen müssen exakt dem Plan entsprechen").toEqual(geplant);
    } finally {
      await cleanupCustomer(id);
    }
  });

  it("YP-5 – der Plan schreibt nichts (read-only-Zusage des Dry-Runs)", async () => {
    // Die Zusage, auf der das ganze Werkzeug steht. Ein Plan-Aufruf, der
    // nebenbei schriebe, wäre gegen eine Prod-Kopie harmlos — gegen Prod nicht.
    const id = await kundeMitStartwert();
    try {
      await curYearUebertrag(id);
      const vorher = await uebertragsZeilen(id);

      await planCarryoverRolls45b(id);
      await planCarryoverRolls45b(id);

      expect(await uebertragsZeilen(id), "planCarryoverRolls45b darf nichts anlegen")
        .toEqual(vorher);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
