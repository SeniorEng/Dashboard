/**
 * Ticket 6hXp9qMrXH2WGVVG — Gate-0-Messung zur §45b-Startwert-Verdrängung.
 *
 * FRAGE, die dieses Skript beantwortet:
 *   Ein §45b-Startwert ist eine INVENTUR — er stellt einen Bestand fest und
 *   ersetzt damit alles, was davor gerechnet wurde. Auf der Verbrauchsseite
 *   tut der Reader das bereits. Auf der Anspruchsseite fehlt die Verdrängung.
 *
 *   Gemessen wird deshalb je Kunde und Stichtag:
 *     IST   = calculateAllocatedCents(...)         — was die App heute liefert
 *     ROH   = alle Allocation-Zeilen               — woraus sie sich speisen kann
 *     SOLL  = IST minus der Zeilen, die ein jüngerer Startwert verdrängen müsste
 *
 *   SOLL wird hier NICHT behauptet, sondern als Differenz ausgewiesen: das
 *   Skript nennt die Zeilen, die unter der Verdrängungsregel entfallen, mit
 *   ihrem Betrag. Ob sie heute in IST eingehen, zeigt der Vergleich.
 *
 * WARUM NICHT IN SQL:
 *   `allocatedCents` = totalCalculated + initialBalance + carryover
 *                      (+ manual_adjustment). `totalCalculated` ist die
 *   virtuelle Monatsaufstockung und hat KEINE Zeile in der Tabelle. Ein
 *   SQL-Nachbau übersieht bei jedem Kunde mit Aufstockung den größten Posten —
 *   genau das ist am 21.09. passiert.
 *
 * READ-ONLY. Keine Schreiboperation, kein Audit-Eintrag, keine Transaktion.
 *
 * Aufruf:
 *   tsx server/scripts/audit-45b-startwert-verdraengung.ts
 *   tsx server/scripts/audit-45b-startwert-verdraengung.ts --json
 */

import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations } from "@shared/schema/budget";
import { calculateAllocatedCents } from "../storage/budget/allocation-storage";

const BUDGET_TYPE = "entlastungsbetrag_45b";
const STICHTAGE = ["2026-06-15", "2026-07-15", new Date().toISOString().slice(0, 10)];

const eur = (c: number) => (c / 100).toFixed(2).padStart(10) + " €";

type Zeile = {
  id: number;
  source: string;
  amountCents: number;
  year: number | null;
  month: number | null;
  validFrom: string;
  expiresAt: string | null;
  notes: string | null;
};

/** Gilt die Zeile zum Stichtag nach ihren eigenen Datumsfeldern? */
function giltZu(z: Zeile, stichtag: string): boolean {
  return z.validFrom <= stichtag && (!z.expiresAt || z.expiresAt >= stichtag);
}

/**
 * Welche Zeilen würde die Verdrängungsregel entfernen?
 * Regel: der jüngste zum Stichtag wirksame Startwert verdrängt jede Zuweisung,
 * deren Gültigkeit FRÜHER beginnt — unabhängig von ihrer Quelle.
 */
function verdraengt(zeilen: Zeile[], stichtag: string): { grenze: string | null; weg: Zeile[] } {
  const gueltig = zeilen.filter(z => giltZu(z, stichtag));
  const startwerte = gueltig.filter(z => z.source === "initial_balance");
  if (startwerte.length === 0) return { grenze: null, weg: [] };
  const grenze = startwerte.reduce((max, z) => (z.validFrom > max ? z.validFrom : max), startwerte[0].validFrom);
  return { grenze, weg: gueltig.filter(z => z.validFrom < grenze) };
}

async function main() {
  const jsonOut = process.argv.includes("--json");

  // Kunden mit mindestens einer aktiven initial_balance-Zeile
  const alleStartwerte = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.budgetType, BUDGET_TYPE),
    eq(budgetAllocations.source, "initial_balance"),
    isNull(budgetAllocations.deletedAt),
  ));
  const kunden = [...new Set(alleStartwerte.map(a => a.customerId))].sort((a, b) => a - b);

  if (kunden.length === 0) {
    console.log("Keine Kunden mit initial_balance-Zeile gefunden.");
    process.exit(0);
  }

  const alleZeilen = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.budgetType, BUDGET_TYPE),
    isNull(budgetAllocations.deletedAt),
    inArray(budgetAllocations.customerId, kunden),
  ));

  const ergebnis: any[] = [];
  let betroffen = 0;
  let summeDifferenz = 0;

  console.log(`\n§45b-Startwert-Verdrängung — Gate-0-Messung (READ-ONLY)`);
  console.log(`Kunden mit Startwert: ${kunden.length}   Stichtage: ${STICHTAGE.join(", ")}\n`);

  for (const cid of kunden) {
    const zeilen: Zeile[] = alleZeilen
      .filter(a => a.customerId === cid)
      .map(a => ({
        id: a.id, source: a.source, amountCents: a.amountCents,
        year: a.year, month: a.month, validFrom: a.validFrom,
        expiresAt: a.expiresAt, notes: a.notes,
      }))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));

    const proStichtag: any[] = [];
    let kundeBetroffen = false;

    for (const t of STICHTAGE) {
      const ist = await calculateAllocatedCents(cid, BUDGET_TYPE, { asOfDate: t });
      const { grenze, weg } = verdraengt(zeilen, t);
      const wegSumme = weg.reduce((s, z) => s + z.amountCents, 0);
      const rohGueltig = zeilen.filter(z => giltZu(z, t)).reduce((s, z) => s + z.amountCents, 0);
      if (weg.length > 0) { kundeBetroffen = true; summeDifferenz += wegSumme; }
      proStichtag.push({
        stichtag: t, istCents: ist, rohGueltigCents: rohGueltig,
        aufstockungCents: ist - rohGueltig,
        verdraengungsGrenze: grenze,
        verdraengteZeilen: weg.map(z => ({ id: z.id, source: z.source, amountCents: z.amountCents, validFrom: z.validFrom })),
        verdraengtCents: wegSumme,
        sollCents: ist - wegSumme,
      });
    }
    if (kundeBetroffen) betroffen++;

    ergebnis.push({ customerId: cid, zeilen, proStichtag });

    if (!jsonOut) {
      const mark = kundeBetroffen ? " ← BETROFFEN" : "";
      console.log(`── Kunde ${cid}${mark}`);
      for (const z of zeilen) {
        console.log(`   ${z.source.padEnd(16)} ${eur(z.amountCents)}  gueltig ${z.validFrom} bis ${z.expiresAt ?? "—".padEnd(10)}  J/M ${z.year ?? "—"}/${z.month ?? "—"}`);
      }
      for (const p of proStichtag) {
        const diff = p.verdraengtCents;
        console.log(`   ${p.stichtag}   IST ${eur(p.istCents)}   davon Zeilen ${eur(p.rohGueltigCents)}   Aufstockung ${eur(p.aufstockungCents)}` +
          (diff ? `   →  SOLL ${eur(p.sollCents)}   DIFFERENZ ${eur(diff)}` : `   →  keine Verdraengung`));
        for (const v of p.verdraengteZeilen) {
          console.log(`        verdraengt: #${v.id} ${v.source} ${eur(v.amountCents)} ab ${v.validFrom}  (Grenze ${p.verdraengungsGrenze})`);
        }
      }
      console.log("");
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ stichtage: STICHTAGE, kunden: ergebnis }, null, 1));
  } else {
    console.log("═".repeat(72));
    console.log(`Kunden gesamt:        ${kunden.length}`);
    console.log(`davon betroffen:      ${betroffen}`);
    console.log(`Summe Differenzen:    ${eur(summeDifferenz)}  (über alle Stichtage, nicht entzerrt)`);
    console.log("");
    console.log("Lesehinweis: 'Aufstockung' ist IST minus Summe der Tabellenzeilen —");
    console.log("also der Teil, den ein SQL-Nachbau nicht sieht. Ist er 0, hätte der");
    console.log("Nachbau zufällig gestimmt.");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error("Fehler:", err); process.exit(1); });
}
