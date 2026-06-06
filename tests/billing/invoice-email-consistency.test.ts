/**
 * Task #573 — Firmen-E-Mail in Rechnungs-/Leistungsnachweis-Templates
 * zwischen Kopf und Fuß vereinheitlichen.
 *
 * Garantien:
 *   - Die in Header und Footer gerenderte E-Mail-Adresse ist identisch
 *     und entspricht exakt `data.companyEmail` (Quelle: `company_settings.email`).
 *   - Es gibt keine zweite, abweichende E-Mail-Schreibweise im Output
 *     (keine hartkodierte Adresse im Template).
 */

import { describe, it, expect } from "vitest";
import {
  generateInvoiceHtml,
  generateLeistungsnachweisHtml,
  buildInvoiceFooterTemplate,
  buildLeistungsnachweisFooterTemplate,
  type InvoicePdfData,
} from "../../server/lib/pdf-generator";

function makePdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    companyName: "Pflege GmbH",
    companyAddress: "Musterstr. 1, 12345 Musterstadt",
    companyPhone: "+49 30 1234",
    companyEmail: "info@pflege-engel.de",
    companyWebsite: null,
    steuernummer: null,
    ustId: null,
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Commerzbank",
    ikNummer: null,
    geschaeftsfuehrer: "Erika Musterfrau",
    invoiceNumber: "RE-2026-0001",
    invoiceDate: "01.05.2026",
    invoiceDueDate: null,
    buyerReference: null,
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
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    lineItems: [
      {
        appointmentId: 1,
        appointmentDate: "2026-04-01",
        startTime: "09:00",
        endTime: "10:00",
        serviceDescription: "Hauswirtschaft",
        serviceCode: "hauswirtschaft",
        durationMinutes: 60,
        quantityRaw: 1,
        quantityUnit: "hours",
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

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function uniqueEmailsIn(html: string): string[] {
  const matches = html.match(EMAIL_REGEX) ?? [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

describe("Invoice-/Leistungsnachweis-PDF: Firmen-E-Mail-Konsistenz (Task #573)", () => {
  const customEmail = "kontakt@pflege-engel-test.de";

  it("Rechnung: rendert genau dieselbe E-Mail aus company_settings (Header, keine zweite Schreibweise)", () => {
    // Task #755 — der separate Footer-Grid mit duplizierter E-Mail-/Bank-
    // Adresse wurde entfernt; die Firmen-E-Mail steht nur noch einmal im
    // Header-Kontaktblock. Task #995 — der Body-Footer wanderte in den
    // Puppeteer-`footerTemplate` (buildInvoiceFooterTemplate); dieser trägt
    // KEINE E-Mail. Garantie aus #573 bleibt: keine hartkodierte zweite
    // Adresse irgendwo im Gesamt-Output (Body + Footer-Template).
    const data = makePdfData({ companyEmail: customEmail });
    const html = generateInvoiceHtml(data);
    const footer = buildInvoiceFooterTemplate(data);

    const emails = uniqueEmailsIn(html + footer);
    expect(emails).toEqual([customEmail.toLowerCase()]);

    expect(html, "Header-Bereich soll companyEmail enthalten").toContain(customEmail);
  });

  it("Rechnung: keine hartkodierte Fallback-Adresse, wenn companyEmail leer ist", () => {
    const data = makePdfData({ companyEmail: "" });
    const emails = uniqueEmailsIn(generateInvoiceHtml(data) + buildInvoiceFooterTemplate(data));
    expect(emails).toEqual([]);
  });

  it("Leistungsnachweis: rendert genau dieselbe E-Mail aus company_settings (keine zweite Schreibweise)", () => {
    // Der Leistungsnachweis blendet im Header bewusst nur Firmenname/IK-Nr.
    // ein (keine Kontaktdaten) und führt die vollständige Kontaktzeile inkl.
    // E-Mail im Footer. Task #995 — dieser Footer ist nun der Puppeteer-
    // `footerTemplate` (buildLeistungsnachweisFooterTemplate), nicht mehr ein
    // Body-Element. Wichtig bleibt: KEINE zweite, hartkodierte Adresse — der
    // Footer-Eintrag ist die einzige Quelle der Wahrheit.
    const data = makePdfData({ companyEmail: customEmail });
    const html = generateLeistungsnachweisHtml(data);
    const footer = buildLeistungsnachweisFooterTemplate(data);

    const emails = uniqueEmailsIn(html + footer);
    expect(emails).toEqual([customEmail.toLowerCase()]);

    expect(footer, "Footer-Template des Leistungsnachweises soll companyEmail enthalten").toContain(customEmail);
  });

  it("Leistungsnachweis: keine hartkodierte Fallback-Adresse, wenn companyEmail leer ist", () => {
    const data = makePdfData({ companyEmail: "" });
    const emails = uniqueEmailsIn(generateLeistungsnachweisHtml(data) + buildLeistungsnachweisFooterTemplate(data));
    expect(emails).toEqual([]);
  });
});
