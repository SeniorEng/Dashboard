/**
 * Task #1905 — `summarizePotAmounts`: DIE EINE Aggregation „Topf-Zeilen →
 * Netto/USt/Brutto".
 *
 * Anlass ist ein Gate-2-Befund: die IST-Beträge der Karte „Noch zu erstellen"
 * lasen die Summen roh aus dem Zeilen-Bauer und verfehlten damit die
 * USt-Reklassifizierung, die `buildInvoiceDraft` beim Erstellen anwendet. Für
 * einen Pflegekassen-Kunden mit `acceptsPrivatePayment` und ausgeschöpftem Topf
 * lag der angezeigte Betrag dadurch bis zu 19 % unter dem, was tatsächlich
 * abgerechnet wird — in genau der Spalte, die als Erwartungswert gelesen wird.
 *
 * Diese Tests halten die Regel an EINER Stelle fest; Rechnung UND Anzeige rufen
 * dieselbe Funktion.
 */
import { describe, it, expect } from "vitest";
import { summarizePotAmounts } from "@shared/domain/budget-invoice-split";
import type { InvoicePotKey } from "@shared/domain/budget-invoice-split";

function pots(
  entries: Array<[InvoicePotKey, number[]]>,
): Map<InvoicePotKey, { totalCents: number }[]> {
  return new Map(
    entries.map(([pot, cents]) => [pot, cents.map((c) => ({ totalCents: c }))]),
  );
}

describe("summarizePotAmounts — Single-Pot", () => {
  it("Kassen-Topf: USt bleibt die des Zeilen-Bauers (0 %)", () => {
    const r = summarizePotAmounts({
      potItems: pots([["entlastungsbetrag_45b", [10000]]]),
      billingType: "pflegekasse_gesetzlich",
      builderNetCents: 10000,
      builderVatCents: 0,
    });
    expect(r).toMatchObject({ netCents: 10000, vatCents: 0, grossCents: 10000 });
    expect(r.needsBudgetSplit).toBe(false);
    expect(r.singlePotIsPrivate).toBe(false);
  });

  it("Selbstzahler, Privat-Topf: die 19 % des Bauers bleiben (keine Doppelrechnung)", () => {
    const r = summarizePotAmounts({
      potItems: pots([["private", [10000]]]),
      billingType: "selbstzahler",
      builderNetCents: 10000,
      builderVatCents: 1900,
    });
    expect(r.vatCents).toBe(1900);
    expect(r.grossCents).toBe(11900);
    expect(r.singlePotIsPrivate).toBe(true);
  });

  it("Pflegekasse + einziger Topf privat: Reklassifizierung auf 19 % (der S1-Fall)", () => {
    // Ausgeschöpfter §45b-Topf + `acceptsPrivatePayment` ⇒ alles landet privat,
    // die Rechnung geht als Selbstzahler-Rechnung raus. Der Zeilen-Bauer hat
    // USt 0 gerechnet (Kunden-billingType ist USt-befreit) — hier korrigiert.
    const r = summarizePotAmounts({
      potItems: pots([["private", [10000]]]),
      billingType: "pflegekasse_gesetzlich",
      builderNetCents: 10000,
      builderVatCents: 0,
    });
    expect(r.vatCents).toBe(1900);
    expect(r.grossCents).toBe(11900);
  });

  it("Pflegekasse ohne erlaubte Privatzahlung: KEINE Reklassifizierung", () => {
    // Anzeige-Pfad über noch nicht gebuchte Termine: der Privat-Topf entsteht
    // allein aus der fehlenden Buchung (Fallback), nicht aus einem echten
    // Privatanteil. 19 % aufzuschlagen wäre erfundene Genauigkeit.
    const r = summarizePotAmounts({
      potItems: pots([["private", [10000]]]),
      billingType: "pflegekasse_gesetzlich",
      builderNetCents: 10000,
      builderVatCents: 0,
      allowPrivateReclassification: false,
    });
    expect(r.vatCents).toBe(0);
    expect(r.grossCents).toBe(10000);
  });

  it("leere Topf-Menge ⇒ 0, ohne Sonderfall", () => {
    const r = summarizePotAmounts({
      potItems: pots([]),
      billingType: "pflegekasse_gesetzlich",
      builderNetCents: 0,
      builderVatCents: 0,
    });
    expect(r).toMatchObject({ netCents: 0, vatCents: 0, grossCents: 0 });
  });
});

describe("summarizePotAmounts — Multi-Pot", () => {
  it("Kassen-Töpfe 0 %, Privat-Topf 19 %, je Topf gerundet", () => {
    const r = summarizePotAmounts({
      potItems: pots([
        ["entlastungsbetrag_45b", [12500]],
        ["private", [3333]],
      ]),
      billingType: "pflegekasse_gesetzlich",
      // Bauer-Summen werden im Multi-Pot-Zweig bewusst NICHT verwendet —
      // absichtlich abweichend gesetzt, damit ein Rückfall auffiele.
      builderNetCents: 999999,
      builderVatCents: 999999,
    });
    expect(r.netCents).toBe(15833);
    expect(r.vatCents).toBe(Math.round((3333 * 1900) / 10000)); // 633
    expect(r.grossCents).toBe(15833 + 633);
    expect(r.needsBudgetSplit).toBe(true);
    expect(r.singlePotIsPrivate).toBe(false);
  });

  it("USt wird je Topf gerundet, nicht auf der Gesamtsumme", () => {
    // Zwei Privat-Zeilen in EINEM Topf ⇒ eine Rundung auf deren Summe.
    const r = summarizePotAmounts({
      potItems: pots([
        ["umwandlung_45a", [1]],
        ["private", [5, 5]],
      ]),
      billingType: "pflegekasse_gesetzlich",
      builderNetCents: 11,
      builderVatCents: 0,
    });
    expect(r.netCents).toBe(11);
    expect(r.vatCents).toBe(Math.round((10 * 1900) / 10000)); // 2
  });
});
