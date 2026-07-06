/**
 * Task #1659 — Regression: Selbstzahler-USt wurde 100× zu niedrig berechnet
 * (0,19 % statt 19 %).
 *
 * Ursache (Commit `9d6f9d4`): `services.vatRate` ist als PROZENT gespeichert
 * (19), der Rechnungs-Pfad rechnet USt aber in Basispunkten
 * (`round(netto × rateBP / 10000)`). Der Refactor las `svc.vatRate` (= 19) roh
 * in eine irreführend `vatBasisPoints` benannte Variable und teilte durch
 * 10000 → 0,19 %. Fix: `serviceVatRateBP()` übersetzt Prozent → Basispunkte
 * (19 → 1900) als einzige Roh-Zugriffsstelle.
 *
 * Dieser Test friert die Einheiten-Konversion UND den konkreten
 * Zahlen-Roundtrip aus dem Ticket ein (netto 4908 ct → USt 933 ct → brutto
 * 5841 ct) und beweist, dass die alte Roh-Formel die falschen 9 ct erzeugt
 * hätte (Display-vs-Buchung-Drift).
 */
import { describe, expect, it } from "vitest";
import { serviceVatRateBP, STANDARD_VAT_RATE_BP } from "@shared/domain/invoice-vat";

/** Der Rechnungs-Pfad rechnet USt so (identisch in invoice-data.ts). */
function computeVatCents(netCents: number, rateBp: number): number {
  return Math.round((netCents * rateBp) / 10000);
}

describe("serviceVatRateBP — Prozent → Basispunkte (Task #1659)", () => {
  it("19 % (DB-Default) → 1900 Basispunkte === STANDARD_VAT_RATE_BP", () => {
    expect(serviceVatRateBP({ vatRate: 19 })).toBe(1900);
    expect(serviceVatRateBP({ vatRate: 19 })).toBe(STANDARD_VAT_RATE_BP);
  });

  it("wirft bei fehlendem Satz (null/undefined) — kein stilles `|| 0`", () => {
    expect(() => serviceVatRateBP({ vatRate: null, name: "Betreuung" })).toThrow(/MwSt-Satz/);
    expect(() => serviceVatRateBP({ vatRate: undefined })).toThrow(/MwSt-Satz/);
  });

  it("0 % bleibt 0 (explizit befreit) — kein Wurf", () => {
    expect(serviceVatRateBP({ vatRate: 0 })).toBe(0);
  });
});

describe("USt-Berechnung Selbstzahler — 19 % statt 0,19 % (Task #1659)", () => {
  it("netto 4908 ct → USt 933 ct (19 %), brutto 5841 ct", () => {
    const netCents = 4908;
    const vatCents = computeVatCents(netCents, serviceVatRateBP({ vatRate: 19 }));
    expect(vatCents).toBe(933);
    expect(netCents + vatCents).toBe(5841);
  });

  it("die alte Roh-Formel (Prozent durch 10000) hätte falsche 9 ct erzeugt", () => {
    const netCents = 4908;
    // Regression: `svc.vatRate` (= 19) roh als Basispunkte behandelt.
    const buggyVatCents = computeVatCents(netCents, 19);
    expect(buggyVatCents).toBe(9);
    // ⇒ 100× zu niedrig gegenüber der korrekten Berechnung.
    expect(buggyVatCents).not.toBe(933);
  });

  it("steuerbefreiter Topf (rateBp 0) → USt 0", () => {
    expect(computeVatCents(4908, 0)).toBe(0);
  });
});
