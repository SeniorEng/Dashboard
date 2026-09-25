/**
 * `summarizePotAmounts` / `ustFuerTopf` / `ustJeSatz` — die USt je Position
 * nach Tabelle D (§ 4 Nr. 16 g UStG, Ticket 6hcgffPJWm57p72p, bestätigt von
 * Alrik am 25.09.2026).
 *
 * ERSETZT die Fassung aus Task #1905, die die alte Zahlertyp-Regel festhielt
 * („Privat-Topf 19 %", Reklassifizierung im Einzeltopf über `builderVatCents`).
 * Rechnung, Vorschau und Anzeige rufen dieselbe Funktion; diese Tests halten
 * die Regel an EINER Stelle fest. Die e2e-Abnahme (PDF, XML, gespeicherte
 * Rechnung) steht in `tests/billing/ust-4-16g.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { summarizePotAmounts, ustFuerTopf, type PotAmountItem } from "@shared/domain/invoice-amounts";
import { ustJeSatz, ustSatzBP } from "@shared/domain/invoice-vat";
import type { InvoicePotKey } from "@shared/domain/budget-invoice-split";

const HW = "hauswirtschaft";
const AB = "alltagsbegleitung";
const KM = "travel_km";
/** Eine Leistung AUSSERHALB der Anerkennungsliste (nicht im Katalog). */
const GARTEN = "gartenpflege";

function pos(cents: number, code: string, pg: number | null, haupt: string[] = [code]): PotAmountItem {
  return { totalCents: cents, serviceCode: code, pflegegradAmLeistungstag: pg, hauptleistungenDesTermins: haupt };
}

function pots(entries: Array<[InvoicePotKey, PotAmountItem[]]>): Map<InvoicePotKey, PotAmountItem[]> {
  return new Map(entries);
}

describe("Tabelle D — Satz je Position (`ustSatzBP`)", () => {
  const privat = { kassenTopf: false };
  const kasse = { kassenTopf: true };

  it("D1: Leistung der Liste + PG nachgewiesen → steuerfrei (Pflichtfall 2/3)", () => {
    expect(ustSatzBP(pos(1, HW, 2), privat)).toBe(0);
    expect(ustSatzBP(pos(1, AB, 5), privat)).toBe(0);
  });

  it("D2: Leistung der Liste OHNE nachgewiesenen PG → 19 % (Pflichtfall 1/6 — darf nie kippen)", () => {
    expect(ustSatzBP(pos(1, HW, null), privat)).toBe(1900);
    expect(ustSatzBP(pos(1, AB, null), privat)).toBe(1900);
  });

  it("D3: Leistung AUSSERHALB der Liste → 19 %, auch mit PG (Pflichtfall 4)", () => {
    expect(ustSatzBP(pos(1, GARTEN, 3), privat)).toBe(1900);
  });

  it("D1/D4 (RK-1): Kassen-Topf → steuerfrei, auch ohne nachgewiesenen PG", () => {
    expect(ustSatzBP(pos(1, HW, null), kasse)).toBe(0);
    expect(ustSatzBP(pos(1, HW, 3), kasse)).toBe(0);
  });

  it("D6: Kilometer folgen der Hauptleistung — PG + alle Hauptleistungen auf der Liste → steuerfrei", () => {
    expect(ustSatzBP(pos(1, KM, 3, [HW, AB]), privat)).toBe(0);
  });

  it("D6/RK-2: Kilometer bei einem Termin mit Leistung AUSSERHALB der Liste → 19 %", () => {
    expect(ustSatzBP(pos(1, KM, 3, [HW, GARTEN]), privat)).toBe(1900);
  });

  it("D6: Kilometer ohne Hauptleistung → 19 % (nichts, dem sie folgen könnten)", () => {
    expect(ustSatzBP(pos(1, KM, 3, []), privat)).toBe(1900);
  });

  it("D7: Kilometer ohne nachgewiesenen PG → 19 %", () => {
    expect(ustSatzBP(pos(1, KM, null, [HW]), privat)).toBe(1900);
  });

  it("D8: Ausfall-/No-Show-Pauschale → 0 %, mit und ohne PG", () => {
    expect(ustSatzBP(pos(1, "no_show_charge", null, []), privat)).toBe(0);
    expect(ustSatzBP(pos(1, "no_show_charge", 2, []), privat)).toBe(0);
  });

  it("ungültiger Grad (0) zählt nicht als Nachweis", () => {
    expect(ustSatzBP(pos(1, HW, 0), privat)).toBe(1900);
  });
});

describe("`ustFuerTopf` / `ustJeSatz` — Rundung je Satz auf die Summe", () => {
  it("E2: RE-2026-0378, 291,01 € ohne PG → 55,29 € (je Satz auf die Summe, nicht je Zeile)", () => {
    // Drei Positionen, deren Einzelrundung 55,30 ergäbe (0,5-Grenzen) —
    // gerundet wird EINMAL auf die Summe: round(29101 × 0,19) = round(5529,19).
    const t = ustFuerTopf("private", [pos(10050, HW, null), pos(10050, HW, null), pos(9001, AB, null)]);
    expect(t.netCents).toBe(29101);
    expect(t.vatCents).toBe(5529);
  });

  it("E1: RE-2026-0595, 299,85 € ohne PG → 56,97 € unverändert", () => {
    const t = ustFuerTopf("private", [pos(29985, HW, null)]);
    expect(t.vatCents).toBe(5697);
  });

  it("gemischte Position im selben Topf: USt nur auf den steuerpflichtigen Teil", () => {
    const t = ustFuerTopf("private", [pos(10000, HW, 3), pos(5000, GARTEN, 3)]);
    expect(t.items.map((i) => i.vatRateBp)).toEqual([0, 1900]);
    expect(t.gruppen).toEqual([
      { satzBP: 0, basisCents: 10000, ustCents: 0 },
      { satzBP: 1900, basisCents: 5000, ustCents: 950 },
    ]);
    expect(t.vatCents).toBe(950);
  });

  it("Storno: negative Basis ergibt exakt das Negative, auch an der x,5-Grenze", () => {
    // 50 ct × 19 % = 9,5 ct → +10; das Storno muss −10 ergeben, nicht −9.
    expect(ustJeSatz([{ totalCents: 50, vatRateBp: 1900 }]).ustCents).toBe(10);
    expect(ustJeSatz([{ totalCents: -50, vatRateBp: 1900 }]).ustCents).toBe(-10);
  });
});

describe("`summarizePotAmounts` — Rechnung und Anzeige", () => {
  it("E5 Funke: Kasse 184,60 + Überlauf privat 9,60 mit PG 3 → 194,20 € brutto", () => {
    const r = summarizePotAmounts({
      potItems: pots([
        ["entlastungsbetrag_45b", [pos(18460, HW, 3)]],
        ["private", [pos(960, HW, 3)]],
      ]),
      billingType: "pflegekasse_gesetzlich",
    });
    expect(r).toMatchObject({ netCents: 19420, vatCents: 0, grossCents: 19420 });
  });

  it("Selbstzahler ohne PG: 19 % (Leitplanke)", () => {
    const r = summarizePotAmounts({ potItems: pots([["private", [pos(10000, HW, null)]]]), billingType: "selbstzahler" });
    expect(r).toMatchObject({ netCents: 10000, vatCents: 1900, grossCents: 11900, singlePotIsPrivate: true });
  });

  it("E6 Selbstzahler MIT PG: steuerfrei, das Netto bleibt", () => {
    const r = summarizePotAmounts({ potItems: pots([["private", [pos(10000, HW, 2)]]]), billingType: "selbstzahler" });
    expect(r).toMatchObject({ netCents: 10000, vatCents: 0, grossCents: 10000 });
  });

  it("Anzeige-Pfad: Privat-Topf nur aus fehlender Buchung (privatePotIsTaxable=false) → keine USt", () => {
    const r = summarizePotAmounts({
      potItems: pots([["entlastungsbetrag_45b", [pos(10000, HW, null)]], ["private", [pos(5000, HW, null)]]]),
      billingType: "pflegekasse_gesetzlich",
      privatePotIsTaxable: false,
    });
    expect(r).toMatchObject({ netCents: 15000, vatCents: 0, grossCents: 15000, needsBudgetSplit: true });
  });

  it("leere Topf-Menge ⇒ 0", () => {
    const r = summarizePotAmounts({ potItems: pots([]), billingType: "pflegekasse_gesetzlich" });
    expect(r).toMatchObject({ netCents: 0, vatCents: 0, grossCents: 0 });
  });
});
