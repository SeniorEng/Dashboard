import { describe, it, expect } from "vitest";
import {
  classifyPaymentDifference,
  isPaymentFullyCovered,
  PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
} from "@shared/domain/qonto/payment-difference";

describe("classifyPaymentDifference", () => {
  it("liefert exact bei identischem Betrag", () => {
    const c = classifyPaymentDifference({ invoiceGrossCents: 57210, paidCents: 57210 });
    expect(c.result).toBe("exact");
    expect(c.differenceCents).toBe(0);
    expect(isPaymentFullyCovered(c)).toBe(true);
  });

  it("akzeptiert eine Abweichung genau an der Toleranzgrenze als tolerated", () => {
    const under = classifyPaymentDifference({
      invoiceGrossCents: 57210,
      paidCents: 57210 - PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
    });
    expect(under.result).toBe("tolerated");
    expect(under.differenceCents).toBe(PAYMENT_DIFFERENCE_TOLERANCE_CENTS);
    expect(isPaymentFullyCovered(under)).toBe(true);

    const over = classifyPaymentDifference({
      invoiceGrossCents: 57210,
      paidCents: 57210 + PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
    });
    expect(over.result).toBe("tolerated");
    expect(over.differenceCents).toBe(-PAYMENT_DIFFERENCE_TOLERANCE_CENTS);
    expect(isPaymentFullyCovered(over)).toBe(true);
  });

  it("markiert eine Abweichung ein Cent über der Toleranz als underpaid/overpaid", () => {
    const under = classifyPaymentDifference({
      invoiceGrossCents: 57210,
      paidCents: 57210 - PAYMENT_DIFFERENCE_TOLERANCE_CENTS - 1,
    });
    expect(under.result).toBe("underpaid");
    expect(under.differenceCents).toBe(PAYMENT_DIFFERENCE_TOLERANCE_CENTS + 1);
    expect(isPaymentFullyCovered(under)).toBe(false);

    const over = classifyPaymentDifference({
      invoiceGrossCents: 57210,
      paidCents: 57210 + PAYMENT_DIFFERENCE_TOLERANCE_CENTS + 1,
    });
    expect(over.result).toBe("overpaid");
    expect(over.differenceCents).toBe(-(PAYMENT_DIFFERENCE_TOLERANCE_CENTS + 1));
    expect(isPaymentFullyCovered(over)).toBe(false);
  });

  it("markiert den realen RE-2026-0212-Fall (262,00 gezahlt vs 572,10 Rechnung) als underpaid", () => {
    const c = classifyPaymentDifference({ invoiceGrossCents: 57210, paidCents: 26200 });
    expect(c.result).toBe("underpaid");
    expect(c.differenceCents).toBe(31010);
    expect(isPaymentFullyCovered(c)).toBe(false);
  });

  it("rechnet bekanntes Skonto aus der Forderung heraus", () => {
    // Rechnung 500,00; Skonto 3,00 legitim ⇒ erwartete Zahlung 497,00.
    const exact = classifyPaymentDifference({
      invoiceGrossCents: 50000,
      paidCents: 49700,
      skontoCents: 300,
    });
    expect(exact.result).toBe("exact");
    expect(exact.differenceCents).toBe(0);

    // Ohne Skonto-Verrechnung wäre dieselbe Zahlung eine Unterzahlung (>Toleranz).
    const withoutSkonto = classifyPaymentDifference({
      invoiceGrossCents: 50000,
      paidCents: 49700,
    });
    expect(withoutSkonto.result).toBe("underpaid");
    expect(withoutSkonto.differenceCents).toBe(300);
  });

  it("respektiert einen Toleranz-Override", () => {
    const c = classifyPaymentDifference({
      invoiceGrossCents: 10000,
      paidCents: 9500,
      toleranceCents: 500,
    });
    expect(c.result).toBe("tolerated");
    expect(c.differenceCents).toBe(500);
  });
});
