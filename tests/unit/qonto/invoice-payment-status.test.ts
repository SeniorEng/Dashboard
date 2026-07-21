import { describe, it, expect } from "vitest";
import { resolveInvoicePaymentStatus } from "@shared/domain/qonto/invoice-payment-status";
import { PAYMENT_DIFFERENCE_TOLERANCE_CENTS } from "@shared/domain/qonto/payment-difference";

/**
 * Task #1822 — Unit-Absicherung der SSoT `resolveInvoicePaymentStatus`
 * (reine, DB-freie Ableitung „Welchen Status impliziert der kumulierte
 * Zahlungsstand?"). Geldbeträge ausnahmslos Integer-Cents.
 */
describe("resolveInvoicePaymentStatus", () => {
  it("keine Zahlung (paidCents <= 0) ⇒ kein automatischer Status", () => {
    const r = resolveInvoicePaymentStatus({ invoiceGrossCents: 50000, paidCents: 0 });
    expect(r.status).toBeNull();
    // Die Klassifikation wird trotzdem geliefert (für Flagging am Schreibpfad).
    expect(r.classification.result).toBe("underpaid");
    expect(r.classification.differenceCents).toBe(50000);
  });

  it("volle Deckung (exakt) ⇒ bezahlt", () => {
    const r = resolveInvoicePaymentStatus({ invoiceGrossCents: 50000, paidCents: 50000 });
    expect(r.status).toBe("bezahlt");
    expect(r.classification.result).toBe("exact");
    expect(r.classification.differenceCents).toBe(0);
  });

  it("Deckung genau an der Toleranzgrenze ⇒ bezahlt", () => {
    const r = resolveInvoicePaymentStatus({
      invoiceGrossCents: 50000,
      paidCents: 50000 - PAYMENT_DIFFERENCE_TOLERANCE_CENTS,
    });
    expect(r.status).toBe("bezahlt");
    expect(r.classification.result).toBe("tolerated");
  });

  it("Unterzahlung mit positiver Zahlung ⇒ teilweise_bezahlt (offener Rest = differenceCents)", () => {
    const r = resolveInvoicePaymentStatus({ invoiceGrossCents: 50000, paidCents: 30000 });
    expect(r.status).toBe("teilweise_bezahlt");
    expect(r.classification.result).toBe("underpaid");
    expect(r.classification.differenceCents).toBe(20000); // offener Rest
  });

  it("kumulierte Teilzahlungen, die den Rest exakt decken ⇒ bezahlt (Σ-Gleichheit)", () => {
    // Σ(30000 + 20000) = 50000 = Brutto ⇒ Restforderung 0.
    const r = resolveInvoicePaymentStatus({ invoiceGrossCents: 50000, paidCents: 30000 + 20000 });
    expect(r.status).toBe("bezahlt");
    expect(r.classification.differenceCents).toBe(0);
  });

  it("Skonto wird aus der Restforderung herausgerechnet ⇒ bezahlt", () => {
    const r = resolveInvoicePaymentStatus({
      invoiceGrossCents: 50000,
      paidCents: 49700,
      skontoCents: 300,
    });
    expect(r.status).toBe("bezahlt");
    expect(r.classification.result).toBe("exact");
  });

  it("Über-Toleranz-Überzahlung ⇒ KEIN Status (muss geflaggt werden, nie still bezahlt)", () => {
    const r = resolveInvoicePaymentStatus({
      invoiceGrossCents: 50000,
      paidCents: 50000 + PAYMENT_DIFFERENCE_TOLERANCE_CENTS + 1,
    });
    expect(r.status).toBeNull();
    expect(r.classification.result).toBe("overpaid");
    expect(r.classification.differenceCents).toBe(-(PAYMENT_DIFFERENCE_TOLERANCE_CENTS + 1));
  });
});
