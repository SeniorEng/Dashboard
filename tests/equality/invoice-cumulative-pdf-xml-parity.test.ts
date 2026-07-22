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
  LEGACY_FAHRTKOSTEN_LABEL,
} from "@shared/domain/invoice-line-aggregation";
import { renderLineItemQuantity } from "@shared/domain/invoice-line-items";
import { grossUpUnitPriceCents, resolveVatTreatment } from "@shared/domain/invoice-vat";
import { parseEuroDE } from "@shared/utils/money";

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
    // Task #1098 — neue Rechnungen betten den Pro-Zeilen-Betrag (BT-131) ein.
    includeLineTotalAmount: true,
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

// ---------------------------------------------------------------------------
// Task #1086 — Positions-PARITÄT (Werte, nicht nur Anzahl).
//
// Der Test oben (#1085) beweist nur, dass PDF und XML gleich VIELE Positionen
// (und genau eine Fahrtkosten-Zeile) zeigen. Hier gehen wir eine Ebene tiefer
// und matchen die Positionen PAARWEISE — beide Render-Schichten iterieren über
// dasselbe `aggregateInvoiceLineItems(...)`-Ergebnis, also ist die Reihenfolge
// identisch und der Index-Match valide. Pro Position prüfen wir bit-genau:
//   - Menge inkl. Einheit (km ⇒ KMT/„… km", Std. ⇒ HUR/„… Std."),
//   - Stückpreis,
//   - Positionsbetrag.
//
// So fällt ein Drift auf, bei dem beide gleich viele Zeilen, aber
// unterschiedliche Mengen/Stückpreise/Beträge rendern (z.B. wenn eine Schicht
// anders rundet als die andere).
//
// Hinweis zum Positionsbetrag (Task #1098): das eingebettete EN-16931-/ZUGFeRD-
// XML trägt seit der BT-131-Korrektur pro Position einen expliziten Pro-Zeilen-
// Betrag (`LineTotalAmount`). Wir prüfen ihn deshalb DIREKT aus dem XML gegen
// PDF und SSoT (`totalCents`) — zusätzlich zur älteren abgeleiteten Identität
// Menge × Stückpreis. Da die Fixture steuerbefreit ist (§45b-Topf, USt = 0),
// gilt netto === brutto und der PDF-Stückpreis (sonst brutto hochgerundet)
// entspricht 1:1 dem XML-Netto-Stückpreis.
// ---------------------------------------------------------------------------

interface PdfRow {
  description: string;
  quantityText: string;
  unitPriceText: string;
  totalText: string;
}

/** Entfernt HTML-Tags und normalisiert Whitespace einer Tabellenzelle. */
function stripCell(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Parst die Positions-Zeilen der PDF-Items-Tabelle. Im `cumulative`-Modus
 * entfallen die Datum-/Uhrzeit-Spalten, jede Zeile hat exakt 4 Zellen:
 * [Beschreibung, Menge, Stückpreis, Betrag].
 */
function parsePdfRows(html: string): PdfRow[] {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  return rows.map((tr) => {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripCell(m[1]));
    if (cells.length !== 4) {
      throw new Error(`Erwartete 4 Zellen je kumulierter PDF-Zeile, bekam ${cells.length}: ${JSON.stringify(cells)}`);
    }
    return { description: cells[0], quantityText: cells[1], unitPriceText: cells[2], totalText: cells[3] };
  });
}

interface XmlLine {
  name: string | null;
  unitCode: string | null;
  quantity: number;
  chargeAmount: string | null;
  lineTotalAmount: string | null;
}

/**
 * Parst die EN-16931-LineItems (Name, Menge+Einheit, Netto-Stückpreis, BT-131
 * Pro-Zeilen-Betrag). BT-131 liegt im `SpecifiedLineTradeSettlement` →
 * `SpecifiedTradeSettlementLineMonetarySummation` → `LineTotalAmount`.
 */
function parseXmlLines(xml: string): XmlLine[] {
  const blocks = xml
    .split("<ram:IncludedSupplyChainTradeLineItem>")
    .slice(1)
    .map((p) => p.split("</ram:IncludedSupplyChainTradeLineItem>")[0]);
  return blocks.map((b) => {
    const name = b.match(/<ram:Name>([^<]*)<\/ram:Name>/)?.[1] ?? null;
    const charge = b.match(/<ram:ChargeAmount>([^<]*)<\/ram:ChargeAmount>/)?.[1] ?? null;
    const qty = b.match(/<ram:BilledQuantity unitCode="([^"]*)">([^<]*)<\/ram:BilledQuantity>/);
    const lineTotal = b.match(/<ram:LineTotalAmount>([^<]*)<\/ram:LineTotalAmount>/)?.[1] ?? null;
    return {
      name,
      unitCode: qty ? qty[1] : null,
      quantity: qty ? Number(qty[2]) : NaN,
      chargeAmount: charge,
      lineTotalAmount: lineTotal,
    };
  });
}

/** Wandelt die deutsche PDF-Mengen-Anzeige zurück in eine Zahl (km bzw. Std.). */
function parsePdfQuantityToNumber(text: string): number {
  if (/km/.test(text)) {
    // „5,00 km" → 5  (Tausenderpunkt entfernen, Komma → Punkt).
    return Number(text.replace(/\s*km/, "").replace(/\./g, "").replace(",", "."));
  }
  // „3 Std." / „1 Std. 30 Min." / „45 Min." → Dezimalstunden.
  const std = text.match(/(\d+)\s*Std\./);
  const min = text.match(/(\d+)\s*Min\./);
  return (std ? Number(std[1]) : 0) + (min ? Number(min[1]) : 0) / 60;
}

/** Stückpreis-Zelle („0,35 €/km") → Cents. */
function parsePdfUnitPriceCents(text: string): number {
  const noUnit = text.replace(/\/(km|Std\.)\s*$/, "").trim();
  const cents = parseEuroDE(noUnit);
  if (cents == null) throw new Error(`Konnte PDF-Stückpreis nicht parsen: "${text}"`);
  return cents;
}

/** XML-Dezimalbetrag ("0.35") → Cents. */
function xmlDecimalToCents(decimal: string | null): number {
  if (decimal == null) throw new Error("XML-Betrag fehlt");
  return Math.round(Number(decimal) * 100);
}

describe("Task #1086 — kumulierte Rechnung: PDF == E-Rechnung-XML (Werte je Position)", () => {
  const data = makeData();
  const treatment = resolveVatTreatment({ billingType: data.billingType, budgetType: data.budgetType });
  const expectedAggregated = aggregateInvoiceLineItems(LINE_ITEMS);

  let pdfRows: PdfRow[];
  let xmlLines: XmlLine[];

  beforeAll(async () => {
    const html = generateInvoiceHtml(data);
    const generated = await generateZugferdXml(data);
    if (!generated) throw new Error("ZUGFeRD-XML konnte nicht generiert werden");
    pdfRows = parsePdfRows(html);
    xmlLines = parseXmlLines(generated);
  });

  it("Voraussetzung: steuerbefreite Fixture (USt = 0) ⇒ Netto-Stückpreis === Brutto-Anzeige", () => {
    expect(treatment).not.toBe("standard");
    expect(data.vatAmountCents).toBe(0);
    // Bei steuerfreier Behandlung rundet die PDF-Stückpreisspalte nicht hoch.
    for (const line of expectedAggregated) {
      expect(grossUpUnitPriceCents(line.unitPriceCents, treatment)).toBe(line.unitPriceCents);
    }
  });

  it("gleiche Anzahl paarbarer Positionen in PDF, XML und SSoT", () => {
    expect(pdfRows).toHaveLength(expectedAggregated.length);
    expect(xmlLines).toHaveLength(expectedAggregated.length);
  });

  it("pro Position: Menge (inkl. Einheit) bit-genau identisch in PDF und XML", () => {
    expectedAggregated.forEach((expected, i) => {
      const pdf = pdfRows[i];
      const x = xmlLines[i];
      const isKm = expected.quantityUnit === "km";

      // PDF-Anzeige === exakt die zentrale Mengen-Formatierung der SSoT-Position.
      expect(pdf.quantityText).toBe(renderLineItemQuantity(expected));
      // Einheit: km ⇒ „… km" + KMT, Std. ⇒ HUR.
      expect(/km/.test(pdf.quantityText)).toBe(isKm);
      expect(x.unitCode).toBe(isKm ? "KMT" : "HUR");

      // XML-Menge === SSoT-Menge (quantityRaw) bit-genau.
      expect(x.quantity).toBe(expected.quantityRaw ?? null);
      // Cross-Layer: aus der PDF-Anzeige zurückgerechnete Menge === XML-Menge.
      expect(parsePdfQuantityToNumber(pdf.quantityText)).toBeCloseTo(x.quantity, 5);
    });
  });

  it("pro Position: Stückpreis bit-genau identisch in PDF und XML", () => {
    expectedAggregated.forEach((expected, i) => {
      const pdfCents = parsePdfUnitPriceCents(pdfRows[i].unitPriceText);
      const xmlCents = xmlDecimalToCents(xmlLines[i].chargeAmount);
      expect(pdfCents).toBe(xmlCents);
      expect(pdfCents).toBe(expected.unitPriceCents);
    });
  });

  it("pro Position: Positionsbetrag bit-genau (PDF == SSoT == Menge × Stückpreis aus XML)", () => {
    expectedAggregated.forEach((expected, i) => {
      const pdfTotalCents = parseEuroDE(pdfRows[i].totalText);
      expect(pdfTotalCents).not.toBeNull();
      // PDF-Betrag === gebuchter SSoT-Betrag.
      expect(pdfTotalCents).toBe(expected.totalCents);
      // Aus den XML-Werten (Menge × Netto-Stückpreis) abgeleiteter Betrag === SSoT.
      const xmlImpliedCents = Math.round(xmlLines[i].quantity * xmlDecimalToCents(xmlLines[i].chargeAmount));
      expect(xmlImpliedCents).toBe(expected.totalCents);
      // ⇒ damit gilt auch PDF-Betrag === XML-abgeleiteter Betrag.
      expect(pdfTotalCents).toBe(xmlImpliedCents);
    });
  });

  // Task #1098 — Pro-Zeilen-Betrag DIREKT aus dem XML (BT-131, `LineTotalAmount`)
  // gegen PDF und SSoT prüfen, statt ihn nur über Menge × Stückpreis abzuleiten.
  // node-zugferd MUSS pro Position einen expliziten `LineTotalAmount` ausgeben.
  it("pro Position: BT-131 (LineTotalAmount) direkt im XML == PDF == SSoT", () => {
    expectedAggregated.forEach((expected, i) => {
      const xmlLineTotalCents = xmlDecimalToCents(xmlLines[i].lineTotalAmount);
      // BT-131 direkt aus dem XML === gebuchter SSoT-Betrag (totalCents).
      expect(xmlLineTotalCents).toBe(expected.totalCents);
      // …und === PDF-Betrag.
      const pdfTotalCents = parseEuroDE(pdfRows[i].totalText);
      expect(xmlLineTotalCents).toBe(pdfTotalCents);
    });
  });

  it("Σ(BT-131) der XML-Positionen === Nettobetrag (Reconciliation)", () => {
    const sumLineTotals = xmlLines.reduce((s, l) => s + xmlDecimalToCents(l.lineTotalAmount), 0);
    expect(sumLineTotals).toBe(NET_AMOUNT_CENTS);
  });

  it("gemergte Fahrtkosten-Zeile: 5,00 km × 0,35 € = 1,75 € in PDF und XML", () => {
    const idx = expectedAggregated.findIndex((l) => l.serviceDescription === FAHRTKOSTEN_LABEL);
    expect(idx).toBeGreaterThanOrEqual(0);
    const pdf = pdfRows[idx];
    const x = xmlLines[idx];

    expect(pdf.description).toContain(FAHRTKOSTEN_LABEL);
    expect(x.name).toBe(FAHRTKOSTEN_LABEL);

    // Menge: travel_km (3) + customer_km (2) = 5,00 km (quantizeKm).
    expect(pdf.quantityText).toBe("5,00 km");
    expect(x.quantity).toBe(5);
    expect(x.unitCode).toBe("KMT");

    // Stückpreis 0,35 €, Betrag 1,75 €.
    expect(parsePdfUnitPriceCents(pdf.unitPriceText)).toBe(35);
    expect(xmlDecimalToCents(x.chargeAmount)).toBe(35);
    expect(parseEuroDE(pdf.totalText)).toBe(175);
    // BT-131 (Pro-Zeilen-Betrag) direkt aus dem XML.
    expect(xmlDecimalToCents(x.lineTotalAmount)).toBe(175);
  });
});

// ---------------------------------------------------------------------------
// Task #1825 — Fahrtkosten-Label „Fahrtkosten/Anfahrt" (neue Rechnungen) vs.
// Bestands-Re-Render mit dem eingefrorenen alten Label „Fahrtkosten".
//
// Der eingefrorene Label-Wert (Render-Snapshot) MUSS identisch durch BEIDE
// Aggregations-Pfade (PDF-Generator und ZUGFeRD-Builder) fließen, damit PDF und
// eingebettetes XML nicht auseinanderdriften. Fehlt der Snapshot-Wert (Bestand
// VOR dieser Umbenennung), setzt der Orchestrator `fahrtkostenLabel` auf das
// alte Label → byte-stabile PDF-/XML-Reproduktion.
// ---------------------------------------------------------------------------
describe("Task #1825 — Fahrtkosten-Label: neu vs. Bestand (Parität PDF/XML)", () => {
  it("neue Rechnung ohne fahrtkostenLabel rendert Fahrtkosten/Anfahrt in PDF und XML", async () => {
    const data = makeData();
    const html = generateInvoiceHtml(data);
    const xml = await generateZugferdXml(data);
    if (!xml) throw new Error("ZUGFeRD-XML konnte nicht generiert werden");

    expect(html).toContain(FAHRTKOSTEN_LABEL);
    expect(html).not.toMatch(new RegExp(`>${LEGACY_FAHRTKOSTEN_LABEL}<`));
    expect(xml).toContain(`<ram:Name>${FAHRTKOSTEN_LABEL}</ram:Name>`);
  });

  it("Bestands-Rechnung mit altem fahrtkostenLabel rendert altes Label in PDF und XML", async () => {
    const data: InvoicePdfData = { ...makeData(), fahrtkostenLabel: LEGACY_FAHRTKOSTEN_LABEL };
    const html = generateInvoiceHtml(data);
    const xml = await generateZugferdXml(data);
    if (!xml) throw new Error("ZUGFeRD-XML konnte nicht generiert werden");

    // Beide Schichten zeigen das alte Label — Parität bleibt gewahrt.
    expect(xml).toContain(`<ram:Name>${LEGACY_FAHRTKOSTEN_LABEL}</ram:Name>`);
    expect(xml).not.toContain(`<ram:Name>${FAHRTKOSTEN_LABEL}</ram:Name>`);

    const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
    expect([...tbody.matchAll(new RegExp(LEGACY_FAHRTKOSTEN_LABEL, "g"))].length).toBe(1);
    expect(tbody).not.toContain(FAHRTKOSTEN_LABEL);
  });
});
