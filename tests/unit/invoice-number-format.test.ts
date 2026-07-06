// Unit-Test für die Rechnungsnummer-SSoT (shared/domain/invoice-number.ts).
// Vorwärts-Regel: Jahr ≤ 2026 → 4-stellig, Jahr ≥ 2027 → 5-stellig; Padding
// ist immer eine MINDEST-Breite, nie eine Obergrenze.

import { describe, it, expect } from "vitest";
import {
  INVOICE_NUMBER_WIDE_PAD_FROM_YEAR,
  invoiceNumberPadWidth,
  formatInvoiceNumber,
} from "@shared/domain/invoice-number";

describe("formatInvoiceNumber — Jahres-abhängiges Padding", () => {
  it("Cutover-Jahr ist 2027", () => {
    expect(INVOICE_NUMBER_WIDE_PAD_FROM_YEAR).toBe(2027);
  });

  it("Jahre ≤ 2026 nullen die laufende Nummer 4-stellig", () => {
    expect(invoiceNumberPadWidth(2025)).toBe(4);
    expect(invoiceNumberPadWidth(2026)).toBe(4);
    expect(formatInvoiceNumber(2026, 1)).toBe("RE-2026-0001");
    expect(formatInvoiceNumber(2026, 275)).toBe("RE-2026-0275");
    expect(formatInvoiceNumber(2026, 9999)).toBe("RE-2026-9999");
  });

  it("Jahre ≤ 2026 kappen NICHT — 5-stellige Sequenzen wachsen weiter", () => {
    expect(formatInvoiceNumber(2026, 10000)).toBe("RE-2026-10000");
  });

  it("Jahre ≥ 2027 nullen die laufende Nummer 5-stellig", () => {
    expect(invoiceNumberPadWidth(2027)).toBe(5);
    expect(invoiceNumberPadWidth(2030)).toBe(5);
    expect(formatInvoiceNumber(2027, 1)).toBe("RE-2027-00001");
    expect(formatInvoiceNumber(2027, 275)).toBe("RE-2027-00275");
    expect(formatInvoiceNumber(2027, 9999)).toBe("RE-2027-09999");
    expect(formatInvoiceNumber(2028, 1)).toBe("RE-2028-00001");
  });

  it("Jahre ≥ 2027 kappen NICHT — Sequenzen > 99999 wachsen 6-stellig weiter", () => {
    expect(formatInvoiceNumber(2027, 100000)).toBe("RE-2027-100000");
  });

  it("bleibt kompatibel mit dem Parser der Konsumenten (RE-JJJJ-Sequenz)", () => {
    // Gap-Checker (server/lib/invariants.ts) und Avis-Parser lesen die Sequenz
    // über eine variable-Länge-Regex zurück — das 5-stellige Format muss auf
    // dieselbe Ganzzahl zurückführen.
    const consumerRe = /^RE-(\d{4})-(\d+)$/;
    const wide = formatInvoiceNumber(2027, 275);
    const m = consumerRe.exec(wide);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(2027);
    expect(Number(m![2])).toBe(275);
  });
});
