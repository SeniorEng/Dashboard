/**
 * Task #1135 — Regressionswächter für die Umbruch-Regeln der Belegtabelle.
 *
 * Task #1132 hat behoben, dass kurze Werte (Datum, Uhrzeit, Dauer/Km,
 * Einzelpreis, Betrag) in der Rechnungs- und Leistungsnachweis-Tabelle
 * unsauber mitten im Wort umbrachen. Die Korrektur ist reines CSS im
 * PDF-Template (`server/lib/pdf-generator.ts`):
 *   - alle Wert-Zellen stehen unter `white-space: nowrap`,
 *   - nur die Leistungs-/Beschreibungs-Spalten (`col-service` / `col-desc`)
 *     brechen über `overflow-wrap: break-word` auf Wortgrenzen um,
 *   - die alte pauschale `overflow-wrap: anywhere`-Regel auf `table.items td`
 *     existiert nicht mehr.
 *
 * Es gab bisher keinen automatischen Schutz davor, dass die alte, fehlerhafte
 * Regel versehentlich wiederkehrt oder die Wrap-Klassen verloren gehen. Dieser
 * leichtgewichtige String-Test generiert beide Dokument-Templates und prüft die
 * CSS-Regeln direkt — ohne Chromium, ohne DB.
 */
import { describe, it, expect } from "vitest";
import {
  generateInvoiceHtml,
  generateLeistungsnachweisHtml,
  type InvoicePdfData,
} from "../../server/lib/pdf-generator";

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-WRAP-2026-0001",
    invoiceDate: "2026-01-15",
    invoiceType: "rechnung",
    billingType: "selbstzahler",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Beispiel GmbH",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    companyPhone: "030123456",
    companyEmail: "info@example.de",
    companyWebsite: null,
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Commerzbank",
    bankAccountHolder: null,
    ikNummer: "",
    ustId: "",
    steuernummer: "",
    geschaeftsfuehrer: "Erika Beispiel",
    insuranceProviderName: null,
    insuranceIkNummer: "",
    versichertennummer: "",
    pflegegrad: null,
    recipientName: "Max Mustermann",
    recipientAddress: "Hauptstraße 5\n10117 Berlin",
    customerName: "Max Mustermann",
    customerAddress: "Hauptstraße 5\n10117 Berlin",
    customerGeburtsdatum: null,
    netAmountCents: 5000,
    vatAmountCents: 0,
    grossAmountCents: 5000,
    vatRate: 0,
    notes: null,
    invoiceDueDate: null,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    lineItems: [
      {
        appointmentId: 1,
        serviceCode: "HW",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        unitPriceCents: 5000,
        totalCents: 5000,
        appointmentDate: "2026-01-10",
        startTime: "09:00:00",
        endTime: "10:00:00",
        employeeName: "Anna Helfer",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    ...overrides,
  } as unknown as InvoicePdfData;
}

// Normalisiert Whitespace, damit die Assertions robust gegen Einrückung/Umbrüche
// im Template-Quelltext sind.
function squish(html: string): string {
  return html.replace(/\s+/g, " ");
}

describe("Task #1135 — Umbruch-Regeln der Belegtabelle", () => {
  describe("Rechnung (generateInvoiceHtml)", () => {
    const css = squish(generateInvoiceHtml(buildPdfData()));

    it("setzt alle Wert-Zellen auf white-space: nowrap", () => {
      expect(css).toContain("table.items td, table.items th { white-space: nowrap; }");
    });

    it("lässt nur die Leistungs-Spalte (col-service) auf Wortgrenzen umbrechen", () => {
      expect(css).toMatch(
        /table\.items td\.col-service, table\.items th\.col-service \{ white-space: normal; overflow-wrap: break-word; word-break: normal;/,
      );
    });

    it("verwendet NICHT mehr die pauschale overflow-wrap: anywhere-Regel", () => {
      expect(css).not.toContain("overflow-wrap: anywhere");
    });
  });

  describe("Leistungsnachweis (generateLeistungsnachweisHtml)", () => {
    const css = squish(generateLeistungsnachweisHtml(buildPdfData()));

    it("setzt alle Wert-Zellen auf white-space: nowrap", () => {
      expect(css).toContain("table.items td, table.items th { white-space: nowrap; }");
    });

    it("lässt nur Leistung (col-service) und Beschreibung (col-desc) auf Wortgrenzen umbrechen", () => {
      expect(css).toMatch(
        /table\.items td\.col-service, table\.items th\.col-service, table\.items td\.col-desc, table\.items th\.col-desc \{ white-space: normal; overflow-wrap: break-word; word-break: normal;/,
      );
    });

    it("verwendet NICHT mehr die pauschale overflow-wrap: anywhere-Regel", () => {
      expect(css).not.toContain("overflow-wrap: anywhere");
    });
  });
});
