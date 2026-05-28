import { describe, it, expect } from "vitest";
import { generateInvoiceHtml, type InvoicePdfData } from "../../server/lib/pdf-generator";
import { generateZugferdXml } from "../../server/lib/zugferd";

/**
 * Task #761 — Regressionstest "Abweichender Kontoinhaber landet im PDF und im
 * ZUGFeRD-XML".
 *
 * Hintergrund: Task #757 hat das Feld `bankAccountHolder` (BT-85) in drei
 * Stellen verdrahtet — Render-Snapshot, PDF-Zahlungsblock und (auf Daten-
 * Ebene) ZUGFeRD-`paymentMeans.payeeAccount.accountName`. Dieser Test fixiert
 * die Anzeige-Pfade (PDF/HTML) und dient als Drift-Detektor für die
 * XML-Emission.
 *
 * WICHTIG — beim Schreiben dieses Tests entdeckter, eigenständiger Befund:
 *   Das aktuell verwendete `node-zugferd`-BASIC-Profil enthält **gar keinen**
 *   XPath für `<ram:AccountName>` (BT-85). Darüber hinaus ist die in
 *   `server/lib/zugferd.ts` aufgebaute `paymentMeans`-Datenstruktur
 *   (`paymentMeans.payeeAccount.iban`, `payeeInstitution.bic`) NICHT die
 *   vom Library-Schema erwartete (`paymentInstruction.transfers[].
 *   paymentAccountIdentifier` + `sellerBankInformation.serviceProviderIdentifier`).
 *   Konsequenz: Im aktuell generierten ZUGFeRD-XML fehlt der komplette
 *   `<ram:SpecifiedTradeSettlementPaymentMeans>`-Block — IBAN, BIC UND
 *   AccountName werden alle stillschweigend verworfen. Das ist eine
 *   GoBD-/E-Rechnungs-Lücke, die über den Scope von Task #761
 *   ("Regressionstest schreiben") hinausgeht; sie ist als Follow-Up zu
 *   adressieren. Der XML-Pfad wird unten deshalb mit `it.fails` markiert —
 *   er schlägt heute fehl (vitest invertiert die Assertion, der Test gilt
 *   als grün) und wird automatisch rot, sobald jemand den Payment-Block
 *   korrekt verdrahtet. Damit ist es gleichzeitig ein Drift-Detektor:
 *   Wer den Fix implementiert, weiß sofort, dass dieser Test angepasst
 *   werden muss.
 */

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-AH-2025-0001",
    invoiceDate: "2025-01-15",
    invoiceType: "selbstzahler",
    billingYear: 2025,
    billingMonth: 1,
    companyName: "Pflegedienst Beispiel GmbH",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Commerzbank",
    bankAccountHolder: null,
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
        appointmentDate: "2025-01-10",
        startTime: "09:00:00",
        endTime: "10:00:00",
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

const HOLDER = "Erika Beispiel (Inhaberin)";
const COMPANY = "Pflegedienst Beispiel GmbH";

describe("Task #761 — Abweichender Kontoinhaber im PDF (HTML-Pfad)", () => {
  it("rendert den abweichenden Kontoinhaber im HTML-Zahlungsblock, wenn gesetzt", () => {
    const html = generateInvoiceHtml(buildPdfData({ bankAccountHolder: HOLDER }));
    expect(html).toContain("Kontoinhaber:");
    expect(html).toContain(HOLDER);
    expect(html).not.toMatch(
      new RegExp(`<td class="value">${COMPANY}</td>\\s*</tr>\\s*<tr><td class="label">IBAN:`),
    );
  });

  it("fällt im HTML auf den Firmennamen zurück, wenn bankAccountHolder=null", () => {
    const html = generateInvoiceHtml(buildPdfData({ bankAccountHolder: null }));
    expect(html).toContain("Kontoinhaber:");
    expect(html).toContain(COMPANY);
    expect(html).not.toContain(HOLDER);
  });

  it("fällt im HTML auf den Firmennamen zurück bei whitespace-only bankAccountHolder", () => {
    const html = generateInvoiceHtml(buildPdfData({ bankAccountHolder: "   " }));
    expect(html).toContain("Kontoinhaber:");
    expect(html).toContain(COMPANY);
    expect(html).not.toContain(HOLDER);
  });
});

describe("Task #761 — Abweichender Kontoinhaber im ZUGFeRD-XML", () => {
  // Pfad (b) aus der Task-Beschreibung. Heute gebrochen — siehe Datei-Header.
  // Sobald der Payment-Block in `server/lib/zugferd.ts` korrekt verdrahtet
  // ist, schlägt dieser Test fehl (weil die Assertion dann tatsächlich
  // greift) und MUSS auf eine echte `it` umgestellt werden.
  it.fails(
    "schreibt den abweichenden Kontoinhaber als <ram:AccountName> in das ZUGFeRD-XML (heute gebrochen: gesamter PaymentMeans-Block fehlt)",
    async () => {
      const xml = await generateZugferdXml(buildPdfData({ bankAccountHolder: HOLDER }));
      expect(xml).not.toBeNull();
      expect(xml).toContain(`<ram:AccountName>${HOLDER}</ram:AccountName>`);
    },
  );

  it("Fallback ohne abweichenden Kontoinhaber: XML enthält kein <ram:AccountName> (auch heute schon erfüllt — Payment-Block fehlt komplett)", async () => {
    const xml = await generateZugferdXml(buildPdfData({ bankAccountHolder: null }));
    expect(xml).not.toBeNull();
    expect(xml).not.toContain("<ram:AccountName>");
    // Sicherung gegen versehentliches Einsickern des abweichenden Holders
    // in den Fallback-Pfad.
    expect(xml).not.toContain(HOLDER);
  });

  it("Drift-Detektor zwischen Datenmodell und XML-Output: was an `bankAccountHolder` übergeben wird, darf NICHT zusätzlich als Firmenname im Seller-Block landen", async () => {
    const xml = await generateZugferdXml(buildPdfData({ bankAccountHolder: HOLDER }));
    expect(xml).not.toBeNull();
    // Der SellerTradeParty-Name MUSS der companyName bleiben (BT-27), nicht
    // der Kontoinhaber. Dieser Test schützt davor, dass ein späterer "Fix"
    // den AccountName versehentlich in `seller.name` schreibt.
    expect(xml).toContain(`<ram:Name>${COMPANY}</ram:Name>`);
  });
});
