/**
 * Task #1111 — Schneller Konformitäts-Wächter für die eingebettete E-Rechnung
 * OHNE Java/veraPDF/Mustang.
 *
 * Hintergrund: Die offizielle EN-16931-Konformität hängt an subtilen
 * node-zugferd-Formen, die ein Refactor von `buildZugferdData` leise wieder
 * kaputtmachen könnte:
 *   - Im Settlement-HEADER müssen die KORREKTEN Schlüssel `paymentInstruction`
 *     (BG-16) und `vatBreakdown` (BG-23) stehen — NICHT die gleichnamigen
 *     Zeilen-Schlüssel `paymentMeans`/`tradeTax`, die node-zugferd im Header
 *     STILL verwirft (dann fehlt im XML die Verkäufer-IBAN bzw. die
 *     USt-Aufschlüsselung).
 *   - `transfers` (unter `paymentInstruction`) und `vatBreakdown` müssen ARRAYS
 *     sein — als Einzelobjekt würde node-zugferd den Inhalt (z.B. die IBAN)
 *     ebenfalls still verwerfen (Mustang BR-CO-27).
 *
 * Das vollständige Mustang/KoSIT/veraPDF-Gate läuft nur in CI (braucht eine
 * Java-Runtime). Dieser reine Unit-Test (keine DB, kein Java, kein App-Server)
 * rendert das eingebettete XML einer frisch konformen Rechnung und prüft die
 * beiden Pflicht-Anker direkt am XML-/PDF-Bytestream, sodass eine Regression
 * schon im normalen lokalen `vitest`-Lauf auffliegt.
 *
 * Sibling-Pattern: erweitert `tests/equality/zugferd-xml-rerender.test.ts`
 * (Determinismus) um den Konformitäts-Aspekt (Pflicht-Inhalte vorhanden).
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { embedZugferdXml, generateZugferdXml } from "../../server/lib/zugferd";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

/**
 * Eine frisch versiegelte, EN-16931-konforme Rechnung: `strictSettlement`
 * erzwingt die korrekten Header-Schlüssel (`paymentInstruction`/`vatBreakdown`),
 * `includeConformantSettlement` schaltet die XMP-Namespace-Reparatur scharf.
 */
function buildConformantPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-2026-1111",
    invoiceDate: "15.01.2026",
    invoiceDueDate: "29.01.2026",
    invoiceType: "pflegekasse_gesetzlich",
    billingType: "pflegekasse_gesetzlich",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Test",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "123456789",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "987654321",
    versichertennummer: "A123456789",
    recipientName: "AOK Nordost",
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    customerName: "Max Mustermann",
    customerGeburtsdatum: "1940-03-15",
    pflegegrad: 3,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    bankAccountHolder: null,
    budgetType: "entlastungsbetrag_45b",
    netAmountCents: 4500,
    vatAmountCents: 0,
    grossAmountCents: 4500,
    vatRate: 0,
    // Flags einer frisch versiegelten Rechnung (DEFAULT_ZUGFERD_PROFILE=en16931):
    strictSettlement: true,
    includeConformantSettlement: true,
    includeLineTotalAmount: true,
    lineAggregation: "cumulative",
    lineItems: [
      {
        appointmentId: 101,
        appointmentDate: "2026-01-05",
        startTime: "09:00",
        endTime: "10:00",
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        quantityRaw: 1,
        quantityUnit: "hours",
        unitPriceCents: 4500,
        totalCents: 4500,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    appointments: [],
    signatures: [],
    ...overrides,
  } as unknown as InvoicePdfData;
}

async function makeBlankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

describe("Task #1111 — EN-16931-Konformitäts-Wächter (kein Java nötig)", () => {
  it("Header enthält die Verkäufer-IBAN (ram:IBANID unter PayeePartyCreditorFinancialAccount)", async () => {
    const xml = await generateZugferdXml(buildConformantPdfData());
    expect(xml).not.toBeNull();
    const x = xml as string;

    // BG-16 Zahlungsweg muss im Settlement-HEADER landen. node-zugferd
    // serialisiert `paymentInstruction.transfers[].paymentAccountIdentifier`
    // zu `ram:IBANID` innerhalb von `PayeePartyCreditorFinancialAccount`.
    expect(x).toContain("PayeePartyCreditorFinancialAccount");
    expect(x).toMatch(
      /<ram:PayeePartyCreditorFinancialAccount>\s*<ram:IBANID>DE89370400440532013000<\/ram:IBANID>/,
    );
  });

  it("Header enthält eine USt-Aufschlüsselung (ApplicableTradeTax/vatBreakdown)", async () => {
    const xml = await generateZugferdXml(buildConformantPdfData());
    expect(xml).not.toBeNull();
    const x = xml as string;

    // BG-23 USt-Aufschlüsselung muss im Settlement-HEADER stehen (NICHT nur in
    // den Zeilen). Verankert am Settlement-Header, damit ein nur-Zeilen-Tax
    // den Test nicht fälschlich grün macht.
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    expect(headerStart).toBeGreaterThan(-1);
    const headerTaxIdx = x.indexOf("ApplicableTradeTax", headerStart);
    expect(headerTaxIdx).toBeGreaterThan(-1);

    const headerTaxBlock = x.slice(headerTaxIdx, headerTaxIdx + 400);
    expect(headerTaxBlock).toContain("<ram:TypeCode>VAT</ram:TypeCode>");
    expect(headerTaxBlock).toMatch(/<ram:BasisAmount>45\.00<\/ram:BasisAmount>/);
    expect(headerTaxBlock).toContain("<ram:CategoryCode>E</ram:CategoryCode>");
  });

  it("Negativ-Kontrolle: ohne strictSettlement fehlen IBAN UND Header-USt im XML", async () => {
    // Beweist, dass die obigen Anker echt am korrekten Header-Schlüssel hängen
    // und nicht trivial wahr sind: mit den Bestands-Schlüsseln
    // (`paymentMeans`/`tradeTax`) verwirft node-zugferd den Header-Inhalt still.
    const xml = await generateZugferdXml(buildConformantPdfData({ strictSettlement: false }));
    expect(xml).not.toBeNull();
    const x = xml as string;

    expect(x).not.toContain("IBANID");
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    expect(headerStart).toBeGreaterThan(-1);
    expect(x.indexOf("ApplicableTradeTax", headerStart)).toBe(-1);
  });

  it("XMP-Namespace-Reparatur (rdf:about) ist im eingebetteten PDF/A angewendet", async () => {
    const blank = await makeBlankPdf();
    const result = await embedZugferdXml(blank, buildConformantPdfData(), { strict: false });

    // Die Einbettung muss tatsächlich gegriffen haben (sonst prüfen wir nichts).
    expect(result.xml).not.toBeNull();

    const bytes = result.pdf.toString("latin1");
    // node-zugferd emittiert das illegale `xmlns:about=""` (ein Präfix auf den
    // leeren Namespace) — die längenerhaltende Reparatur ersetzt es durch das
    // korrekte `rdf:about=""`. Ohne Reparatur bricht der XMP-Parse → veraPDF
    // meldet PDF/A-3b als nicht konform.
    expect(bytes).toContain('rdf:about=""');
    expect(bytes).not.toContain('xmlns:about=""');
  });
});
