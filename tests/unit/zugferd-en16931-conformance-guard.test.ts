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

  it("Task #1116 — jede Zeile trägt BT-131 LineTotalAmount (includeLineTotalAmount: true)", async () => {
    // node-zugferd verwirft den Pro-Zeilen-Betrag STILL, wenn der falsche
    // Schlüssel (`totalAmount`) benutzt wird; BT-131 muss als `lineTotalAmount`
    // emittiert werden. Eine frische Rechnung setzt `includeLineTotalAmount` und
    // MUSS pro Zeile ein `SpecifiedTradeSettlementLineMonetarySummation` mit
    // `LineTotalAmount` führen. Ein Refactor, der wieder auf `totalAmount`
    // zurückfällt, fliegt hier auf (sonst nur im CI-Mustang/veraPDF-Gate mit Java).
    const xml = await generateZugferdXml(buildConformantPdfData());
    expect(xml).not.toBeNull();
    const x = xml as string;

    // Anker innerhalb der Zeile (vor dem Settlement-Header), damit der
    // Header-`monetarySummation.lineTotalAmount` (BT-106) den Test nicht
    // fälschlich grün macht.
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    expect(headerStart).toBeGreaterThan(-1);
    const lineSection = x.slice(0, headerStart);

    expect(lineSection).toContain("SpecifiedTradeSettlementLineMonetarySummation");
    expect(lineSection).toMatch(
      /<ram:SpecifiedTradeSettlementLineMonetarySummation>\s*<ram:LineTotalAmount>45\.00<\/ram:LineTotalAmount>/,
    );
  });

  it("Negativ-Kontrolle: ohne includeLineTotalAmount fehlt BT-131 in den Zeilen (byte-stabiler Bestandspfad)", async () => {
    // Beweist, dass der Anker echt am `lineTotalAmount`-Schlüssel hängt: der
    // Bestandspfad (`totalAmount`) wird von node-zugferd still verworfen, sodass
    // weder `LineTotalAmount` noch das umschließende
    // `SpecifiedTradeSettlementLineMonetarySummation` im Zeilenblock erscheinen.
    const xml = await generateZugferdXml(
      buildConformantPdfData({ includeLineTotalAmount: false }),
    );
    expect(xml).not.toBeNull();
    const x = xml as string;

    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    expect(headerStart).toBeGreaterThan(-1);
    const lineSection = x.slice(0, headerStart);

    expect(lineSection).not.toContain("SpecifiedTradeSettlementLineMonetarySummation");
    expect(lineSection).not.toContain("LineTotalAmount");
  });

  it("Selbstzahler: Header-USt hat CategoryCode S, korrekten Satz und nicht-null CalculatedAmount", async () => {
    // Task #1115 — Private/Selbstzahler-Rechnungen nehmen die regelbesteuerte
    // Form: 19% USt, Steuer-CategoryCode "S", ein nicht-null CalculatedAmount
    // und KEIN Befreiungsgrund. `vatRate` ist in Basispunkten gespeichert
    // (STANDARD_VAT_RATE_BP = 1900 ⇒ RateApplicablePercent 19, vgl.
    // server/services/invoice-calc.ts).
    const xml = await generateZugferdXml(
      buildConformantPdfData({
        invoiceNumber: "RE-2026-1115",
        invoiceType: "selbstzahler",
        billingType: "selbstzahler",
        budgetType: null,
        netAmountCents: 10000,
        vatAmountCents: 1900,
        grossAmountCents: 11900,
        vatRate: 1900,
        // Selbstzahler-Rechnungen haben keine Versicherten-/Kassen-Daten:
        insuranceIkNummer: "",
        versichertennummer: "",
        ikNummer: "",
        ustId: "DE123456789",
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
            unitPriceCents: 10000,
            totalCents: 10000,
            employeeName: "Anna Beispiel",
            appointmentNotes: null,
            serviceDetails: null,
          },
        ],
      } as unknown as Partial<InvoicePdfData>),
    );
    expect(xml).not.toBeNull();
    const x = xml as string;

    // BG-23 USt-Aufschlüsselung MUSS im Settlement-HEADER stehen.
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    expect(headerStart).toBeGreaterThan(-1);
    const headerTaxIdx = x.indexOf("ApplicableTradeTax", headerStart);
    expect(headerTaxIdx).toBeGreaterThan(-1);

    const headerTaxBlock = x.slice(headerTaxIdx, headerTaxIdx + 400);
    expect(headerTaxBlock).toContain("<ram:TypeCode>VAT</ram:TypeCode>");
    // Regelbesteuert (BR-S-*): Kategorie S, 19% Satz, nicht-null Steuerbetrag.
    expect(headerTaxBlock).toContain("<ram:CategoryCode>S</ram:CategoryCode>");
    expect(headerTaxBlock).toMatch(/<ram:RateApplicablePercent>19<\/ram:RateApplicablePercent>/);
    expect(headerTaxBlock).toMatch(/<ram:BasisAmount>100\.00<\/ram:BasisAmount>/);
    expect(headerTaxBlock).toMatch(/<ram:CalculatedAmount>19\.00<\/ram:CalculatedAmount>/);
    // Kein Befreiungsgrund bei Regelbesteuerung (der ist Kategorie E vorbehalten).
    expect(headerTaxBlock).not.toContain("Umsatzsteuerbefreit");

    // Verkäufer-IBAN bleibt unter PayeePartyCreditorFinancialAccount erhalten.
    expect(x).toContain("PayeePartyCreditorFinancialAccount");
    expect(x).toMatch(
      /<ram:PayeePartyCreditorFinancialAccount>\s*<ram:IBANID>DE89370400440532013000<\/ram:IBANID>/,
    );
  });

  it("Storno (exempt): BT-3 TypeCode 384 + negative Settlement-Totals + IBAN", async () => {
    // Task #1137 — Stornorechnungen nehmen `invoiceType: "stornorechnung"`,
    // wodurch buildZugferdData den Dokument-`typeCode` "384" (Gutschrift/Storno)
    // statt "380" emittiert und negative Monetär-Beträge führt. Ein Refactor der
    // typeCode-/Vorzeichen-Logik würde sonst nur im CI-Mustang/veraPDF-Gate (Java)
    // auffliegen. Dieser reine Unit-Test verankert beides direkt am XML.
    const xml = await generateZugferdXml(
      buildConformantPdfData({
        invoiceNumber: "ST-2026-1137E",
        invoiceType: "stornorechnung",
        // Storno = negative Beträge (Anzeige UND Buchung kehren das Vorzeichen um).
        netAmountCents: -4500,
        vatAmountCents: 0,
        grossAmountCents: -4500,
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
            unitPriceCents: -4500,
            totalCents: -4500,
            employeeName: "Anna Beispiel",
            appointmentNotes: null,
            serviceDetails: null,
          },
        ],
      } as unknown as Partial<InvoicePdfData>),
    );
    expect(xml).not.toBeNull();
    const x = xml as string;

    // BT-3 Dokumenttyp = 384 (Gutschrift/Storno). Anker am ExchangedDocument,
    // damit ein anderer TypeCode (z.B. "58" Zahlungsweg, "VAT" USt) den Test
    // nicht fälschlich grün macht. `ExchangedDocumentContext` (ohne TypeCode)
    // wird übersprungen, indem ab dem öffnenden `<rsm:ExchangedDocument>`-Tag
    // gesucht wird.
    const docStart = x.indexOf("<rsm:ExchangedDocument>");
    expect(docStart).toBeGreaterThan(-1);
    const docTypeIdx = x.indexOf("<ram:TypeCode>", docStart);
    expect(docTypeIdx).toBeGreaterThan(-1);
    expect(x.slice(docTypeIdx, docTypeIdx + 40)).toContain(
      "<ram:TypeCode>384</ram:TypeCode>",
    );

    // Negative Settlement-Totals (BT-106/BT-109/BT-112/BT-115) bleiben erhalten.
    const sumStart = x.indexOf("SpecifiedTradeSettlementHeaderMonetarySummation");
    expect(sumStart).toBeGreaterThan(-1);
    const sumBlock = x.slice(sumStart, sumStart + 600);
    expect(sumBlock).toContain("<ram:LineTotalAmount>-45.00</ram:LineTotalAmount>");
    expect(sumBlock).toContain("<ram:TaxBasisTotalAmount>-45.00</ram:TaxBasisTotalAmount>");
    expect(sumBlock).toContain("<ram:GrandTotalAmount>-45.00</ram:GrandTotalAmount>");
    expect(sumBlock).toContain("<ram:DuePayableAmount>-45.00</ram:DuePayableAmount>");

    // Header-USt bleibt umsatzsteuerbefreit (Kategorie E), Basis negativ.
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    const headerTaxIdx = x.indexOf("ApplicableTradeTax", headerStart);
    expect(headerTaxIdx).toBeGreaterThan(-1);
    const headerTaxBlock = x.slice(headerTaxIdx, headerTaxIdx + 400);
    expect(headerTaxBlock).toContain("<ram:CategoryCode>E</ram:CategoryCode>");
    expect(headerTaxBlock).toMatch(/<ram:BasisAmount>-45\.00<\/ram:BasisAmount>/);

    // Verkäufer-IBAN bleibt unter PayeePartyCreditorFinancialAccount erhalten.
    expect(x).toMatch(
      /<ram:PayeePartyCreditorFinancialAccount>\s*<ram:IBANID>DE89370400440532013000<\/ram:IBANID>/,
    );
  });

  it("Storno (regelbesteuert): TypeCode 384 + negative USt-Beträge (CategoryCode S, 19%)", async () => {
    // Task #1137 — Auch die regelbesteuerte Storno-Form (Selbstzahler/privat,
    // 19% USt) muss TypeCode 384 und durchgehend negative Beträge führen — inkl.
    // negativem CalculatedAmount (BT-117) in der USt-Aufschlüsselung.
    const xml = await generateZugferdXml(
      buildConformantPdfData({
        invoiceNumber: "ST-2026-1137S",
        invoiceType: "stornorechnung",
        billingType: "selbstzahler",
        budgetType: null,
        netAmountCents: -10000,
        vatAmountCents: -1900,
        grossAmountCents: -11900,
        vatRate: 1900,
        insuranceIkNummer: "",
        versichertennummer: "",
        ikNummer: "",
        ustId: "DE123456789",
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
            unitPriceCents: -10000,
            totalCents: -10000,
            employeeName: "Anna Beispiel",
            appointmentNotes: null,
            serviceDetails: null,
          },
        ],
      } as unknown as Partial<InvoicePdfData>),
    );
    expect(xml).not.toBeNull();
    const x = xml as string;

    // BT-3 Dokumenttyp = 384.
    const docStart = x.indexOf("<rsm:ExchangedDocument>");
    expect(docStart).toBeGreaterThan(-1);
    const docTypeIdx = x.indexOf("<ram:TypeCode>", docStart);
    expect(x.slice(docTypeIdx, docTypeIdx + 40)).toContain(
      "<ram:TypeCode>384</ram:TypeCode>",
    );

    // Negative Settlement-Totals inkl. negativer Steuersumme.
    const sumStart = x.indexOf("SpecifiedTradeSettlementHeaderMonetarySummation");
    const sumBlock = x.slice(sumStart, sumStart + 600);
    expect(sumBlock).toContain("<ram:GrandTotalAmount>-119.00</ram:GrandTotalAmount>");
    expect(sumBlock).toContain("<ram:DuePayableAmount>-119.00</ram:DuePayableAmount>");

    // Header-USt: regelbesteuert (Kategorie S, 19%), negativer Steuerbetrag.
    const headerStart = x.indexOf("ApplicableHeaderTradeSettlement");
    const headerTaxIdx = x.indexOf("ApplicableTradeTax", headerStart);
    expect(headerTaxIdx).toBeGreaterThan(-1);
    const headerTaxBlock = x.slice(headerTaxIdx, headerTaxIdx + 400);
    expect(headerTaxBlock).toContain("<ram:CategoryCode>S</ram:CategoryCode>");
    expect(headerTaxBlock).toMatch(/<ram:RateApplicablePercent>19<\/ram:RateApplicablePercent>/);
    expect(headerTaxBlock).toMatch(/<ram:BasisAmount>-100\.00<\/ram:BasisAmount>/);
    expect(headerTaxBlock).toMatch(/<ram:CalculatedAmount>-19\.00<\/ram:CalculatedAmount>/);
  });

  it("Negativ-Kontrolle: normale Rechnung trägt TypeCode 380 (nicht 384)", async () => {
    // Beweist, dass der 384-Anker echt am Storno-Branch hängt und nicht trivial
    // wahr ist: eine reguläre Rechnung emittiert TypeCode 380.
    const xml = await generateZugferdXml(buildConformantPdfData());
    expect(xml).not.toBeNull();
    const x = xml as string;
    const docStart = x.indexOf("<rsm:ExchangedDocument>");
    const docTypeIdx = x.indexOf("<ram:TypeCode>", docStart);
    const docTypeBlock = x.slice(docTypeIdx, docTypeIdx + 40);
    expect(docTypeBlock).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(docTypeBlock).not.toContain("384");
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
