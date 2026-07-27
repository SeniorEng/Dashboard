/**
 * Task #1864 — Unit-Tests für die Absicherung des reinen Betrags-Treffers.
 *
 * Deckt die drei reinen Bausteine ab:
 *  - `isPaymentDateImplausible` (Plausibilitäts-Guard, Tages-Granularität),
 *  - `findAmountMatchCorroboration` (Versichertennummer / Versicherten-Name /
 *    Abrechnungszeitraum im Verwendungszweck; bewusst KEIN Kassen-Name),
 *  - `evaluateAmountOnlyMatch` (Kombination → block/confirm/review).
 */

import { describe, it, expect } from "vitest";
import {
  isPaymentDateImplausible,
  findAmountMatchCorroboration,
  evaluateAmountOnlyMatch,
  AMOUNT_MATCH_REVIEW_CONFIDENCE,
} from "@shared/domain/qonto/amount-match-guard";

describe("isPaymentDateImplausible", () => {
  it("true, wenn die Zahlung an einem Kalendertag VOR der Rechnungserstellung liegt", () => {
    // Reales Bug-Szenario: paid_at 24.06. liegt vor der Rechnung vom 20.07.
    expect(isPaymentDateImplausible(new Date("2026-06-24T09:00:00"), new Date("2026-07-20T10:00:00"))).toBe(true);
  });

  it("false am selben Kalendertag (keine Uhrzeit-Fehlalarme)", () => {
    expect(isPaymentDateImplausible(new Date("2026-07-20T08:00:00"), new Date("2026-07-20T15:00:00"))).toBe(false);
  });

  it("false, wenn die Zahlung nach der Rechnungserstellung liegt", () => {
    expect(isPaymentDateImplausible(new Date("2026-07-25T00:00:00"), new Date("2026-07-20T00:00:00"))).toBe(false);
  });
});

describe("findAmountMatchCorroboration", () => {
  const invoice = {
    customerName: "Bernd Funke",
    versichertennummer: "A123456789",
    billingMonth: 6,
    billingYear: 2026,
  };

  it("belegt über die Versichertennummer (auch mit abweichender Formatierung)", () => {
    expect(findAmountMatchCorroboration("gutschrift vnr a123456789 juni", invoice)).toContain("versichertennummer");
    expect(findAmountMatchCorroboration("vnr a12 345 6789 pflege", invoice)).toContain("versichertennummer");
  });

  it("belegt über den Versicherten-Namen (Kunden-Stammname)", () => {
    expect(findAmountMatchCorroboration("ueberweisung funke pflegeleistung", invoice)).toContain("name");
  });

  it("belegt über den Abrechnungszeitraum in gängigen Schreibweisen", () => {
    for (const ref of [
      "zeitraum 06/2026", "abrechnung 06.2026", "06-2026", "2026-06", "leistungen juni 2026",
    ]) {
      expect(findAmountMatchCorroboration(ref, invoice), ref).toContain("period");
    }
  });

  it("belegt NICHT über eine nackte 6-stellige Ziffernfolge (IBAN-/Nummern-Fehlalarm vermeiden)", () => {
    // „062026" als Teilstring einer längeren Nummer darf keinen Zeitraum belegen.
    expect(findAmountMatchCorroboration("de89370400440532062026", invoice)).not.toContain("period");
  });

  it("belegt NICHT über den Kassen-/Empfängernamen (recipientName wird bewusst ignoriert)", () => {
    // Der Zahler (AOK) steht im Verwendungszweck JEDER Kassenzahlung — das darf
    // einen betragsgleichen Fremd-Treffer NICHT belegen. Da die Funktion nur
    // customerName kennt, belegt „aok bayern" hier nichts.
    expect(findAmountMatchCorroboration("aok bayern sammelzahlung", invoice)).toEqual([]);
  });

  it("kein Beleg beim realen Fehl-Match (fremder Name, fremder Zeitraum, keine VNr)", () => {
    // AOK-Zahlung für „Popp, J." (04-2026) trifft betragsgleich Funkes Juni-Rechnung.
    expect(findAmountMatchCorroboration("popp j zeitraum 04-2026 aok bayern", invoice)).toEqual([]);
  });

  it("kein Beleg bei fehlenden Rechnungsfeldern / leerem Text", () => {
    expect(findAmountMatchCorroboration("", invoice)).toEqual([]);
    expect(findAmountMatchCorroboration("irgendein text", { customerName: null, versichertennummer: null, billingMonth: null, billingYear: null })).toEqual([]);
  });
});

describe("evaluateAmountOnlyMatch", () => {
  const base = {
    invoiceCreatedAt: new Date("2026-07-01T00:00:00"),
    invoice: { customerName: "Bernd Funke", versichertennummer: "A123456789", billingMonth: 6, billingYear: 2026 },
  };

  it("blockiert bei unplausiblem Datum (Zahlung vor Rechnungserstellung) — VOR jeder Beleg-Prüfung", () => {
    const outcome = evaluateAmountOnlyMatch({
      ...base,
      paymentEmittedAt: new Date("2026-06-20T00:00:00"),
      // sogar MIT Beleg im Text bleibt der Datums-Guard vorrangig
      searchText: "funke a123456789 06/2026",
    });
    expect(outcome.decision).toBe("block_implausible_date");
  });

  it("confirm bei plausiblem Datum und vorhandenem Beleg", () => {
    const outcome = evaluateAmountOnlyMatch({
      ...base,
      paymentEmittedAt: new Date("2026-07-05T00:00:00"),
      searchText: "gutschrift funke pflege",
    });
    expect(outcome.decision).toBe("confirm");
    expect(outcome.corroboration).toContain("name");
  });

  it("review bei plausiblem Datum ohne jeden Beleg", () => {
    const outcome = evaluateAmountOnlyMatch({
      ...base,
      paymentEmittedAt: new Date("2026-07-05T00:00:00"),
      searchText: "aok bayern sammelzahlung ohne beleg",
    });
    expect(outcome.decision).toBe("review");
    expect(outcome.corroboration).toEqual([]);
  });

  it("exportiert das erwartete Confidence-Kennzeichen", () => {
    expect(AMOUNT_MATCH_REVIEW_CONFIDENCE).toBe("auto_amount_review");
  });
});
