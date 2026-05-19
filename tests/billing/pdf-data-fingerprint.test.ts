/**
 * Task #522 — Unit-Tests für den PDF-Daten-Fingerprint (Drift-Indikator).
 *
 * Garantien:
 *   - Identische Eingangsdaten → identischer Fingerprint (stabil & deterministisch)
 *   - Reihenfolge der Top-Level-Keys spielt keine Rolle
 *   - Änderung relevanter Felder (Empfänger-Adresse, Positions-Betrag,
 *     Signatur) ändert den Fingerprint
 *   - Rechnung-Fingerprint ist unabhängig von Signaturen; LN-Fingerprint
 *     reagiert auf Signaturänderungen
 */

import { describe, it, expect } from "vitest";
import {
  computeInvoicePdfFingerprint,
  computeLeistungsnachweisFingerprint,
} from "../../server/lib/invoice-pdf-fingerprint";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

function makePdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    companyName: "Pflege GmbH",
    companyAddress: "Musterstr. 1, 12345 Musterstadt",
    companyPhone: "+49 30 1234",
    companyEmail: "info@example.de",
    companyWebsite: null,
    steuernummer: null,
    ustId: null,
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Commerzbank",
    ikNummer: null,
    geschaeftsfuehrer: null,
    invoiceNumber: "RE-2026-0001",
    invoiceDate: "01.05.2026",
    invoiceType: "rechnung",
    billingType: "selbstzahler",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Max Mustermann",
    recipientAddress: "Hauptstr. 1\n10115 Berlin",
    insuranceProviderName: null,
    insuranceIkNummer: null,
    versichertennummer: null,
    pflegegrad: null,
    customerName: "Max Mustermann",
    customerAddress: "Hauptstr. 1\n10115 Berlin",
    customerGeburtsdatum: null,
    lineItems: [
      {
        appointmentId: 1,
        appointmentDate: "2026-04-01",
        startTime: "09:00",
        endTime: "10:00",
        serviceDescription: "Hauswirtschaft",
        serviceCode: "hauswirtschaft",
        durationMinutes: 60,
        unitPriceCents: 3500,
        totalCents: 3500,
        employeeName: "Anna Helfer",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    netAmountCents: 3500,
    vatAmountCents: 0,
    grossAmountCents: 3500,
    vatRate: 0,
    notes: null,
    ...overrides,
  };
}

describe("invoice-pdf-fingerprint", () => {
  it("liefert für identische Daten identischen Fingerprint", () => {
    const fp1 = computeInvoicePdfFingerprint(makePdfData());
    const fp2 = computeInvoicePdfFingerprint(makePdfData());
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64);
  });

  it("ändert sich bei geänderter Empfänger-Adresse", () => {
    const fp1 = computeInvoicePdfFingerprint(makePdfData());
    const fp2 = computeInvoicePdfFingerprint(
      makePdfData({ recipientAddress: "Hauptstr. 99\n10115 Berlin" })
    );
    expect(fp1).not.toBe(fp2);
  });

  it("ändert sich bei geändertem Positions-Betrag", () => {
    const base = makePdfData();
    const fp1 = computeInvoicePdfFingerprint(base);
    const fp2 = computeInvoicePdfFingerprint(
      makePdfData({
        lineItems: [{ ...base.lineItems[0], totalCents: 4000 }],
        netAmountCents: 4000,
        grossAmountCents: 4000,
      })
    );
    expect(fp1).not.toBe(fp2);
  });

  it("Rechnungs-Fingerprint ist unabhängig von Signaturen", () => {
    const fp1 = computeInvoicePdfFingerprint(makePdfData());
    const fp2 = computeInvoicePdfFingerprint(
      makePdfData({
        signatures: [
          {
            employeeSignatureData: "data:image/png;base64,AAA=",
            employeeSignedAt: "2026-04-30",
            employeeName: "Anna Helfer",
            customerSignatureData: null,
            customerSignedAt: null,
            customerName: "Max Mustermann",
            appointmentIds: [1],
            recordType: "monthly",
          },
        ],
      })
    );
    expect(fp1).toBe(fp2);
  });

  it("LN-Fingerprint ändert sich bei neuer Unterschrift", () => {
    const withSig1 = makePdfData({
      signatures: [
        {
          employeeSignatureData: "data:image/png;base64,AAA=",
          employeeSignedAt: "2026-04-30",
          employeeName: "Anna Helfer",
          customerSignatureData: null,
          customerSignedAt: null,
          customerName: "Max Mustermann",
          appointmentIds: [1],
          recordType: "monthly",
        },
      ],
    });
    const withSig2 = makePdfData({
      signatures: [
        {
          employeeSignatureData: "data:image/png;base64,BBB=",
          employeeSignedAt: "2026-04-30",
          employeeName: "Anna Helfer",
          customerSignatureData: null,
          customerSignedAt: null,
          customerName: "Max Mustermann",
          appointmentIds: [1],
          recordType: "monthly",
        },
      ],
    });
    expect(computeLeistungsnachweisFingerprint(withSig1)).not.toBe(
      computeLeistungsnachweisFingerprint(withSig2)
    );
  });

  it("LN-Fingerprint ist invariant gegenüber Signatur-Reihenfolge", () => {
    // enrichPdfDataWithSignatures liest Monatsdaten ohne ORDER BY — die
    // Array-Reihenfolge darf den Fingerprint NICHT verändern, sonst gibt es
    // falschen Drift bei unveränderten Daten.
    const sigA = {
      employeeSignatureData: "data:image/png;base64,AAA=",
      employeeSignedAt: "2026-04-30",
      employeeName: "Anna Helfer",
      customerSignatureData: "data:image/png;base64,CCC=",
      customerSignedAt: "2026-05-01",
      customerName: "Max Mustermann",
      appointmentIds: [1],
      recordType: "monthly" as const,
    };
    const sigB = {
      employeeSignatureData: "data:image/png;base64,BBB=",
      employeeSignedAt: "2026-04-30",
      employeeName: "Bernd Helfer",
      customerSignatureData: null,
      customerSignedAt: null,
      customerName: "Max Mustermann",
      appointmentIds: [2],
      recordType: "monthly" as const,
    };
    const fpForward = computeLeistungsnachweisFingerprint(
      makePdfData({ signatures: [sigA, sigB] })
    );
    const fpReverse = computeLeistungsnachweisFingerprint(
      makePdfData({ signatures: [sigB, sigA] })
    );
    expect(fpForward).toBe(fpReverse);
  });

  it("LN-Fingerprint ändert sich bei nachträglicher Kunden-Unterschrift", () => {
    const base = makePdfData({
      signatures: [
        {
          employeeSignatureData: "data:image/png;base64,AAA=",
          employeeSignedAt: "2026-04-30",
          employeeName: "Anna Helfer",
          customerSignatureData: null,
          customerSignedAt: null,
          customerName: "Max Mustermann",
          appointmentIds: [1],
          recordType: "monthly",
        },
      ],
    });
    const withCustomerSig = makePdfData({
      signatures: [
        {
          employeeSignatureData: "data:image/png;base64,AAA=",
          employeeSignedAt: "2026-04-30",
          employeeName: "Anna Helfer",
          customerSignatureData: "data:image/png;base64,CCC=",
          customerSignedAt: "2026-05-01",
          customerName: "Max Mustermann",
          appointmentIds: [1],
          recordType: "monthly",
        },
      ],
    });
    expect(computeLeistungsnachweisFingerprint(base)).not.toBe(
      computeLeistungsnachweisFingerprint(withCustomerSig)
    );
  });
});
