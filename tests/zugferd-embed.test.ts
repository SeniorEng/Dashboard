import { describe, it, expect, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { embedZugferdXml, generateZugferdXml, ZugferdEmbedError } from "../server/lib/zugferd";
import type { InvoicePdfData } from "../server/lib/pdf-generator";

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-EMBED-2025-0001",
    invoiceDate: "2025-01-15",
    invoiceType: "selbstzahler",
    billingYear: 2025,
    billingMonth: 1,
    companyName: "Pflegedienst Test",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "",
    versichertennummer: "",
    recipientName: "Max Mustermann",
    recipientAddress: "Hauptstraße 5\n10117 Berlin",
    customerName: "Max Mustermann",
    netAmountCents: 5000,
    vatAmountCents: 0,
    grossAmountCents: 5000,
    vatRate: 0,
    lineItems: [
      {
        serviceCode: "HW",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        unitPriceCents: 5000,
        totalCents: 5000,
      },
    ],
    appointments: [],
    signatures: [],
    invoiceDueDate: null,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    customerGeburtsdatum: null,
    pflegegrad: null,
    ...overrides,
  } as unknown as InvoicePdfData;
}

async function makeBlankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

// Minimal-XML, das alle `validateZugferd`-Pflicht-Elemente enthält. Wird in
// den Konformitäts-Tests vom Mock-Invoicer zurückgegeben, damit die XML-
// Validierung passiert und der Code-Pfad bis zur PDF/A-Konformitätsprüfung
// kommt.
const MOCK_VALID_XML =
  "<rsm:CrossIndustryInvoice>" +
  "<rsm:ExchangedDocumentContext/>" +
  "<rsm:ExchangedDocument/>" +
  "<rsm:SupplyChainTradeTransaction>" +
  "<ram:SellerTradeParty/>" +
  "<ram:BuyerTradeParty/>" +
  "<ram:IncludedSupplyChainTradeLineItem/>" +
  "<ram:SpecifiedTradeSettlementHeaderMonetarySummation/>" +
  "</rsm:SupplyChainTradeTransaction>" +
  "</rsm:CrossIndustryInvoice>";

describe("Task #554 — embedZugferdXml Strict-Mode (Send-Pfad)", () => {
  it("wirft ZugferdEmbedError, wenn die IBAN fehlt", async () => {
    const pdf = await makeBlankPdf();
    const data = buildPdfData({ iban: "" });

    await expect(
      embedZugferdXml(pdf, data, { strict: true }),
    ).rejects.toBeInstanceOf(ZugferdEmbedError);

    await expect(
      embedZugferdXml(pdf, data, { strict: true }),
    ).rejects.toThrow(/IBAN fehlt/);
  });

  it("wirft ZugferdEmbedError, wenn die Positionssumme nicht zum Nettobetrag passt", async () => {
    const pdf = await makeBlankPdf();
    // netAmountCents (9999) weicht von der Summe der lineItems (5000) ab —
    // simuliert eine fehlerhafte/negative Position bzw. inkonsistente Daten.
    const data = buildPdfData({ netAmountCents: 9999, grossAmountCents: 9999 });

    await expect(
      embedZugferdXml(pdf, data, { strict: true }),
    ).rejects.toBeInstanceOf(ZugferdEmbedError);

    await expect(
      embedZugferdXml(pdf, data, { strict: true }),
    ).rejects.toThrow(/Positionssumme/);
  });
});

describe("Task #554 — embedZugferdXml Default-Pfad (Preview/PDF-Anzeige)", () => {
  it("fällt still auf das Standard-PDF zurück, wenn die XML-Validierung scheitert", async () => {
    const pdf = await makeBlankPdf();
    const data = buildPdfData({ iban: "" });

    const result = await embedZugferdXml(pdf, data);
    expect(result.xml).toBeNull();
    expect(result.pdf).toBe(pdf);
  });
});

describe("Task #562 — ZUGFeRD-Pflichtfelder im generierten XML", () => {
  it("schreibt BT-9 Fälligkeitsdatum (paymentTerms.dueDate) in das XML", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        invoiceDueDate: "2025-02-14",
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
        insuranceIkNummer: "987654321",
        versichertennummer: "A123456789",
      }),
    );
    expect(xml).not.toBeNull();
    // node-zugferd serialisiert paymentTerms unter
    // ApplicableHeaderTradeSettlement/SpecifiedTradePaymentTerms/DueDateDateTime.
    expect(xml).toMatch(/SpecifiedTradePaymentTerms[\s\S]*DueDateDateTime[\s\S]*20250214/);
  });

  it("schreibt BT-10 BuyerReference, wenn explizit gesetzt", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        buyerReference: "AKTE-2025-0042",
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
      }),
    );
    expect(xml).not.toBeNull();
    expect(xml).toMatch(/<ram:BuyerReference>AKTE-2025-0042<\/ram:BuyerReference>/);
  });

  it("fällt für Pflegekassen-Rechnungen ohne explizite BuyerReference auf die Versicherten-Nr. zurück", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
        versichertennummer: "X999999999",
      }),
    );
    expect(xml).not.toBeNull();
    expect(xml).toMatch(/<ram:BuyerReference>X999999999<\/ram:BuyerReference>/);
  });

  it("schreibt eine IncludedNote mit Versichertendaten (SubjectCode AAK)", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
        versichertennummer: "A123456789",
        customerGeburtsdatum: "1940-03-15",
        pflegegrad: 3,
      }),
    );
    expect(xml).not.toBeNull();
    expect(xml).toMatch(/IncludedNote[\s\S]*Vers\.-Nr\.: A123456789[\s\S]*<ram:SubjectCode>AAK<\/ram:SubjectCode>/);
  });

  it("schreibt keine IncludedNote mit Anerkennungs-Az. (Task #599 — Feld entfernt)", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
      }),
    );
    expect(xml).not.toBeNull();
    expect(xml).not.toMatch(/Anerkennungs-Az\./);
  });

  it("schreibt eine IncludedNote für die Abtretungserklärung (SubjectCode REG)", async () => {
    const xml = await generateZugferdXml(
      buildPdfData({
        invoiceType: "pflegekasse_gesetzlich",
        ikNummer: "123456789",
        assignmentDeclarationDate: "2024-09-01",
        assignmentDeclarationRef: "ABT-2024-007",
      }),
    );
    expect(xml).not.toBeNull();
    expect(xml).toMatch(/IncludedNote[\s\S]*Abtretungserkl[\s\S]*ABT-2024-007[\s\S]*<ram:SubjectCode>REG<\/ram:SubjectCode>/);
  });
});

describe("Task #554 — Konformitätsprüfung nach embedInPdf", () => {
  it("wirft ZugferdEmbedError, wenn das eingebettete PDF kein pdfaid-XMP und kein factur-x.xml enthält (strict)", async () => {
    const blankPdf = await makeBlankPdf();

    vi.resetModules();
    vi.doMock("node-zugferd", () => ({
      zugferd: () => ({
        create: () => ({
          toXML: async () => MOCK_VALID_XML,
          // Liefert einen unveränderten Blank-PDF zurück — kein PDF/A-XMP,
          // kein factur-x.xml-Anhang → Konformitätsprüfung MUSS scheitern.
          embedInPdf: async () => new Uint8Array(blankPdf),
        }),
      }),
    }));
    vi.doMock("node-zugferd/profile/basic", () => ({ BASIC: {} }));

    try {
      const mod = await import("../server/lib/zugferd");
      const data = buildPdfData();

      await expect(
        mod.embedZugferdXml(blankPdf, data, { strict: true }),
      ).rejects.toBeInstanceOf(mod.ZugferdEmbedError);

      await expect(
        mod.embedZugferdXml(blankPdf, data, { strict: true }),
      ).rejects.toThrow(/Konformitätsprüfung fehlgeschlagen/);
    } finally {
      vi.doUnmock("node-zugferd");
      vi.doUnmock("node-zugferd/profile/basic");
      vi.resetModules();
    }
  });

  it("fällt im Default-Pfad still auf das Standard-PDF zurück, wenn die Konformitätsprüfung scheitert", async () => {
    const blankPdf = await makeBlankPdf();

    vi.resetModules();
    vi.doMock("node-zugferd", () => ({
      zugferd: () => ({
        create: () => ({
          toXML: async () => MOCK_VALID_XML,
          embedInPdf: async () => new Uint8Array(blankPdf),
        }),
      }),
    }));
    vi.doMock("node-zugferd/profile/basic", () => ({ BASIC: {} }));

    try {
      const mod = await import("../server/lib/zugferd");
      const data = buildPdfData();

      const result = await mod.embedZugferdXml(blankPdf, data);
      expect(result.xml).toBeNull();
      expect(result.pdf).toBe(blankPdf);
    } finally {
      vi.doUnmock("node-zugferd");
      vi.doUnmock("node-zugferd/profile/basic");
      vi.resetModules();
    }
  });
});
