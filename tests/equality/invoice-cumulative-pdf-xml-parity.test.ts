/**
 * Task #1085 — Anzeige↔E-Rechnung-Parität: PDF und ZUGFeRD/EN-16931-XML zeigen
 * bei einer `cumulative`-Rechnung IMMER dieselben zusammengefassten Positionen.
 *
 * Beide Render-Schichten (`generateInvoiceHtml` für das PDF, `generateZugferdXml`
 * für das eingebettete EN-16931-XML) speisen ihre Positionen aus EINER Quelle
 * (`aggregateInvoiceLineItems`). Dieser Equality-Test rendert beide Schichten aus
 * EXAKT denselben `InvoicePdfData` (mehrere Termine je Leistungstyp + `travel_km`
 * + `customer_km`, `lineAggregation: "cumulative"`) und beweist:
 *   - Σ(totalCents der kumulierten Positionen) === `netAmountCents` (GoBD /
 *     ZUGFeRD-Reconciliation LineTotalSum == Nettobetrag),
 *   - #PDF-Positionen === #XML-LineItems === erwartete kumulierte Zeilenzahl,
 *   - GENAU EINE gemeinsame „Fahrtkosten"-Zeile (travel_km + customer_km gemergt)
 *     in BEIDEN Schichten.
 *
 * Ein künftiges Auseinanderdriften der beiden Render-Schichten (z.B. wenn nur
 * eine Schicht aggregiert) fällt damit sofort auf.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { generateInvoiceHtml, type InvoicePdfData } from "../../server/lib/pdf-generator";
import { generateZugferdXml } from "../../server/lib/zugferd";
import {
  aggregateInvoiceLineItems,
  FAHRTKOSTEN_LABEL,
} from "@shared/domain/invoice-line-aggregation";

function makeLineItem(over: Partial<InvoicePdfData["lineItems"][0]> = {}): InvoicePdfData["lineItems"][0] {
  return {
    appointmentId: 1,
    appointmentDate: "2026-01-05",
    startTime: "10:00",
    endTime: "11:00",
    serviceDescription: "Hauswirtschaft",
    serviceCode: "hauswirtschaft",
    durationMinutes: 60,
    quantityRaw: 1,
    quantityUnit: "hours",
    unitPriceCents: 4500,
    totalCents: 4500,
    employeeName: "Mitarbeiter A",
    appointmentNotes: null,
    serviceDetails: null,
    ...over,
  };
}

// Mehrere Termine je Leistungstyp + zwei Kilometer-Typen, die der Aggregator zu
// einer gemeinsamen Fahrtkosten-Zeile zusammenfasst.
const LINE_ITEMS: InvoicePdfData["lineItems"] = [
  makeLineItem({ appointmentId: 1, serviceCode: "hauswirtschaft", serviceDescription: "Hauswirtschaft", unitPriceCents: 4500, quantityRaw: 1, totalCents: 4500 }),
  makeLineItem({ appointmentId: 2, serviceCode: "hauswirtschaft", serviceDescription: "Hauswirtschaft", unitPriceCents: 4500, quantityRaw: 2, totalCents: 9000 }),
  makeLineItem({ appointmentId: 3, serviceCode: "betreuung", serviceDescription: "Betreuung", unitPriceCents: 5000, quantityRaw: 1, totalCents: 5000 }),
  makeLineItem({ appointmentId: 4, serviceCode: "betreuung", serviceDescription: "Betreuung", unitPriceCents: 5000, quantityRaw: 1, totalCents: 5000 }),
  makeLineItem({ appointmentId: 5, serviceCode: "travel_km", serviceDescription: "Anfahrt", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 3, durationMinutes: 3, totalCents: 105 }),
  makeLineItem({ appointmentId: 6, serviceCode: "customer_km", serviceDescription: "Kundenfahrt", quantityUnit: "km", unitPriceCents: 35, quantityRaw: 2, durationMinutes: 2, totalCents: 70 }),
];

const NET_AMOUNT_CENTS = LINE_ITEMS.reduce((s, li) => s + li.totalCents, 0); // 23675

function makeData(): InvoicePdfData {
  return {
    companyName: "CarePflege GmbH",
    companyAddress: "Musterstr. 1\n10115 Berlin",
    companyPhone: "030123456",
    companyEmail: "info@example.com",
    companyWebsite: null,
    steuernummer: null,
    ustId: null,
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    bankName: "Testbank",
    bankAccountHolder: null,
    ikNummer: "123456789",
    geschaeftsfuehrer: null,
    invoiceNumber: "RE-2026-1085",
    invoiceDate: "06.01.2026",
    invoiceDueDate: "20.01.2026",
    buyerReference: "REF-1",
    invoiceType: "rechnung",
    // Steuerbefreiter §45b-Topf ⇒ vat=0, netto === brutto: hält die
    // Σ(totalCents)-Invariante sauber und ist der Standard-Multi-Termin-Fall.
    billingType: "pflegekasse_gesetzlich",
    budgetType: "entlastungsbetrag_45b",
    billingMonth: 1,
    billingYear: 2026,
    recipientName: "AOK Nordost",
    recipientAddress: "Wilhelmstr. 1\n10963 Berlin",
    insuranceProviderName: "AOK",
    insuranceIkNummer: "987654321",
    versichertennummer: null,
    pflegegrad: 3,
    customerName: "Max Mustermann",
    customerAddress: "Kundenweg 2\n10115 Berlin",
    customerGeburtsdatum: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    lineItems: LINE_ITEMS,
    lineAggregation: "cumulative",
    netAmountCents: NET_AMOUNT_CENTS,
    vatAmountCents: 0,
    grossAmountCents: NET_AMOUNT_CENTS,
    vatRate: 0,
    notes: null,
  };
}

/** Zählt die Positions-Zeilen (`<tr>`) im ersten <tbody> der Items-Tabelle. */
function countPdfLineItemRows(html: string): number {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return [...tbody.matchAll(/<tr>/g)].length;
}

/** Zählt das Vorkommen einer Fahrtkosten-Zeile im PDF-Tabellenkörper. */
function countPdfFahrtkostenRows(html: string): number {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return [...tbody.matchAll(new RegExp(FAHRTKOSTEN_LABEL, "g"))].length;
}

/** Zählt die EN-16931-LineItems (`IncludedSupplyChainTradeLineItem`) im XML. */
function countXmlLineItems(xml: string): number {
  return xml.split("<ram:IncludedSupplyChainTradeLineItem>").length - 1;
}

/** Zählt die Fahrtkosten-LineItems im XML (Produktname == Fahrtkosten-Label). */
function countXmlFahrtkostenItems(xml: string): number {
  const blocks = xml
    .split("<ram:IncludedSupplyChainTradeLineItem>")
    .slice(1)
    .map((p) => p.split("</ram:IncludedSupplyChainTradeLineItem>")[0]);
  return blocks.filter((b) => new RegExp(`<ram:Name>${FAHRTKOSTEN_LABEL}</ram:Name>`).test(b)).length;
}

describe("Task #1085 — kumulierte Rechnung: PDF == E-Rechnung-XML (Positionen)", () => {
  let html: string;
  let xml: string;
  // Erwartete kumulierte Zeilenzahl direkt aus der SSoT-Aggregation ableiten,
  // statt sie zu hardcoden — driftet die Aggregationslogik, driftet die Erwartung mit.
  const expectedAggregated = aggregateInvoiceLineItems(LINE_ITEMS);

  beforeAll(async () => {
    const data = makeData();
    html = generateInvoiceHtml(data);
    const generated = await generateZugferdXml(data);
    if (!generated) throw new Error("ZUGFeRD-XML konnte nicht generiert werden");
    xml = generated;
  });

  it("Aggregation: 2 Service-Zeilen + 1 Fahrtkosten-Zeile, Σ(totalCents) === netAmountCents", () => {
    expect(expectedAggregated).toHaveLength(3);
    const fahrtkosten = expectedAggregated.filter((l) => l.serviceDescription === FAHRTKOSTEN_LABEL);
    expect(fahrtkosten).toHaveLength(1);
    expect(expectedAggregated.reduce((s, l) => s + l.totalCents, 0)).toBe(NET_AMOUNT_CENTS);
  });

  it("#PDF-Positionen === #XML-LineItems === erwartete kumulierte Zeilenzahl", () => {
    const pdfRows = countPdfLineItemRows(html);
    const xmlItems = countXmlLineItems(xml);
    expect(pdfRows).toBe(expectedAggregated.length);
    expect(xmlItems).toBe(expectedAggregated.length);
    expect(pdfRows).toBe(xmlItems);
    // Ohne Kumulierung wären es 6 Einzelzeilen — Beweis, dass beide aggregieren.
    expect(pdfRows).toBeLessThan(LINE_ITEMS.length);
  });

  it("GENAU EINE gemeinsame Fahrtkosten-Zeile in PDF und XML", () => {
    expect(countPdfFahrtkostenRows(html)).toBe(1);
    expect(countXmlFahrtkostenItems(xml)).toBe(1);
  });
});
