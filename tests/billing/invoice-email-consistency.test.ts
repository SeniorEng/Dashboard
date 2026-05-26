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

/**
 * Teilt das HTML am `<div class="footer">` und liefert {head, foot}, sodass
 * beide Bereiche unabhängig auf die Firmen-E-Mail geprüft werden können.
 * Der Header-Bereich der Rechnung (`.header`) enthält bei Cards mit
 * verschachtelten DIVs zu viele Schließ-Tags für eine einfache Greedy-Regex,
 * deshalb splitten wir am Footer-Anker.
 */
function splitHeadAndFoot(html: string): { head: string; foot: string } {
  const footerIdx = html.lastIndexOf('<div class="footer"');
  if (footerIdx === -1) return { head: html, foot: "" };
  return { head: html.slice(0, footerIdx), foot: html.slice(footerIdx) };
}

describe("Invoice-/Leistungsnachweis-PDF: Firmen-E-Mail-Konsistenz (Task #573)", () => {
  const customEmail = "kontakt@pflege-engel-test.de";

  it("Rechnung: rendert in Kopf UND Fuß exakt dieselbe E-Mail aus company_settings", () => {
    const html = generateInvoiceHtml(makePdfData({ companyEmail: customEmail }));

    // Nur EINE unique Adresse im gesamten Output.
    const emails = uniqueEmailsIn(html);
    expect(emails).toEqual([customEmail.toLowerCase()]);

    // Bereiche oberhalb (Header) und ab `<div class="footer">` (Footer)
    // müssen die Adresse jeweils enthalten — beweist Kopf/Fuß-Konsistenz.
    const { head, foot } = splitHeadAndFoot(html);
    expect(head, "Header-Bereich soll companyEmail enthalten").toContain(customEmail);
    expect(foot, "Footer-Bereich soll companyEmail enthalten").toContain(customEmail);

    // Zur Sicherheit: insgesamt ≥ 2× im Output.
    const occurrences = html.split(customEmail).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("Rechnung: keine hartkodierte Fallback-Adresse, wenn companyEmail leer ist", () => {
    const html = generateInvoiceHtml(makePdfData({ companyEmail: "" }));
    const emails = uniqueEmailsIn(html);
    expect(emails).toEqual([]);
  });

  it("Leistungsnachweis: rendert genau dieselbe E-Mail aus company_settings (keine zweite Schreibweise)", () => {
    // Der Leistungsnachweis blendet im Header bewusst nur Firmenname/IK-Nr.
    // ein (keine Kontaktdaten) und führt die vollständige Kontaktzeile inkl.
    // E-Mail im Footer. Wichtig ist hier: KEINE zweite, hartkodierte
    // Adresse — der Footer-Eintrag ist die einzige Quelle der Wahrheit.
    const html = generateLeistungsnachweisHtml(
      makePdfData({ companyEmail: customEmail }),
    );

    const emails = uniqueEmailsIn(html);
    expect(emails).toEqual([customEmail.toLowerCase()]);

    const { foot } = splitHeadAndFoot(html);
    expect(foot, "Footer des Leistungsnachweises soll companyEmail enthalten").toContain(customEmail);
  });

  it("Leistungsnachweis: keine hartkodierte Fallback-Adresse, wenn companyEmail leer ist", () => {
    const html = generateLeistungsnachweisHtml(
      makePdfData({ companyEmail: "" }),
    );
    const emails = uniqueEmailsIn(html);
    expect(emails).toEqual([]);
  });
});
