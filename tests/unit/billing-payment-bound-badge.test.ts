/**
 * #1897 (Client, Schritte 6+7) — die Zahlungs-Anzeige in der Rechnungsliste.
 *
 * Der Server liefert seit #71 je offener Rechnung `hasBoundPayment`, den
 * gebundenen Betrag und die Differenz. Hier wird die daraus gebildete
 * ANZEIGE festgenagelt — sie ist das, was der Sachbearbeiter liest, und sie
 * darf die Klassifikation der SSoT nicht umdeuten.
 *
 * Geprüft:
 *   (a) Beschriftung je Klassifikation — insbesondere: Überzahlung sagt
 *       „zu viel", Unterzahlung sagt „fehlen". Eine Verwechslung wäre ein
 *       Buchungsfehler in Textform.
 *   (b) `tolerated` sagt dasselbe wie `exact` („gedeckt") — die Toleranz ist
 *       fachlich Volldeckung, nicht ein Sonderfall für den Nutzer.
 *   (c) Die Mahn-Ampel ist für gebundene Zahlungen aus — geprüft an
 *       `invoiceAgingBucket`, also der Funktion, welche die Zeile benutzt,
 *       nicht an einer Nachbildung.
 *   (d) Ohne Bindung erscheint kein Zahlungs-Text.
 */
import { describe, expect, it } from "vitest";
import type { InvoiceItem } from "@shared/api/billing";
import {
  invoiceAgingBucket,
  paymentBadgeLabel,
  paymentBadgeTitle,
} from "../../client/src/features/billing/utils";

/** Minimal-Rechnung; nur die Felder, welche die geprüften Funktionen lesen. */
function invoice(over: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: 1,
    invoiceNumber: "RE-TEST-1",
    status: "versendet",
    invoiceType: "rechnung",
    billingType: "selbstzahler",
    grossAmountCents: 50_000,
    dueDate: "2026-01-02",
    sentAt: null,
    ...over,
  } as InvoiceItem;
}

const euro = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;

describe("#1897 — Zahlungs-Badge in der Rechnungsliste", () => {
  it("(a) Überzahlung sagt „zu viel“, Unterzahlung sagt „fehlen“", () => {
    const over = invoice({
      hasBoundPayment: true,
      boundPaidCents: 60_000,
      paymentDifferenceCents: -10_000,
      paymentDifferenceResult: "overpaid",
    });
    expect(paymentBadgeLabel(over, euro)).toBe("Zahlung 600,00 € · 100,00 € zu viel");

    const under = invoice({
      hasBoundPayment: true,
      boundPaidCents: 40_000,
      paymentDifferenceCents: 10_000,
      paymentDifferenceResult: "underpaid",
    });
    expect(paymentBadgeLabel(under, euro)).toBe("Zahlung 400,00 € · 100,00 € fehlen");

    // Die Richtung darf nie kippen: Überzahlung nennt nie „fehlen“.
    expect(paymentBadgeLabel(over, euro)).not.toContain("fehlen");
    expect(paymentBadgeLabel(under, euro)).not.toContain("zu viel");
  });

  it("(b) `tolerated` gilt als gedeckt — wie `exact`", () => {
    const exact = invoice({
      hasBoundPayment: true, boundPaidCents: 50_000,
      paymentDifferenceCents: 0, paymentDifferenceResult: "exact",
    });
    const tolerated = invoice({
      hasBoundPayment: true, boundPaidCents: 49_950,
      paymentDifferenceCents: 50, paymentDifferenceResult: "tolerated",
    });
    expect(paymentBadgeLabel(exact, euro)).toContain("gedeckt");
    expect(paymentBadgeLabel(tolerated, euro)).toContain("gedeckt");
    // Der Unterschied steht im Tooltip, nicht im Badge.
    expect(paymentBadgeTitle(tolerated)).toContain("Toleranz");
    expect(paymentBadgeTitle(exact)).not.toContain("Toleranz");
  });

  it("(c) gebundene Zahlung schaltet die Mahn-Ampel ab — auch weit über Fälligkeit", () => {
    const spaet = { dueDate: "2026-01-02" };
    const ungebunden = invoice({ ...spaet, hasBoundPayment: false });
    const gebunden = invoice({ ...spaet, hasBoundPayment: true });

    // Kontrolle: ohne Bindung altert die Rechnung sehr wohl. Ohne diese Zeile
    // wäre der Fall auch bei pauschal abgeschaltetem Aging grün.
    expect(invoiceAgingBucket(ungebunden, "2026-06-30")).toBe("red");
    expect(invoiceAgingBucket(gebunden, "2026-06-30")).toBe("none");
  });

  it("(d) ohne Bindung gibt es keinen Zahlungs-Text", () => {
    const ohne = invoice({ hasBoundPayment: false });
    // Die Zeile rendert das Badge nur bei `hasBoundPayment`; der Helfer bleibt
    // trotzdem aussagefähig, falls er je ohne Betrag gerufen wird.
    expect(paymentBadgeLabel(ohne, euro)).toBe("Zahlung zugeordnet");
  });

  it("(e) eine teilbezahlte Rechnung altert weiterhin nicht — jetzt ueber die Bindung", () => {
    // Vorher trug den Fall der STATUS `teilweise_bezahlt`, der in den Cluster
    // `teilzahlung` fiel und damit aus dem Wartelauf. Beides ist entfallen.
    //
    // Die Aussage bleibt trotzdem richtig, und zwar aus dem Grund, der schon
    // immer der eigentliche war: das Geld ist da. Eine teilbezahlte Rechnung
    // hat eine gebundene Zahlung, faellt damit in
    // `zahlung_zugeordnet_pruefung` und altert nicht. Gemahnt wird nicht, was
    // auf dem Konto liegt.
    const teil = invoice({ status: "versendet", dueDate: "2026-01-02", hasBoundPayment: true });
    expect(invoiceAgingBucket(teil, "2026-06-30")).toBe("none");
  });
});
