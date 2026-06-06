/**
 * Task #997 (#1/#2) — Renderer-Regression: Anzeige == Buchung im PDF/HTML.
 *
 * Sichert die beiden konkreten Render-Pfade `generateInvoiceHtml` und
 * `generateLeistungsnachweisHtml` gegen die zwei Hauptbugs aus RE-2026-0023:
 *   #1  Der Renderer rechnete jede Zeile unabhängig mit ×1,19 hoch — Σ(Zeilen)
 *       konnte vom Gesamtbetrag abweichen. Jetzt: persistierte USt-Summe wird
 *       drift-frei verteilt ⇒ Σ(Brutto-Zeilen) === Gesamtbetrag.
 *   #2  Die USt-Befreiung wurde am billingType statt am Topf festgemacht; ein
 *       steuerbefreiter Topf konnte einen "USt 0,04 €"-Krümel zeigen. Jetzt:
 *       steuerbefreiter Topf ⇒ netto === brutto, KEIN USt-Ausweis, dafür der
 *       § 4 Nr. 16 UStG-Befreiungshinweis.
 */
import { describe, expect, it } from "vitest";
import { generateInvoiceHtml, generateLeistungsnachweisHtml, type InvoicePdfData } from "../../server/lib/pdf-generator";

function parseDeEuroToCents(s: string): number {
  const normalized = s.replace(/\./g, "").replace(",", ".");
  return Math.round(parseFloat(normalized) * 100);
}

/**
 * Liest die Beträge der „Betrag"-Spalte aus dem ersten <tbody> der
 * Rechnungs-Items-Tabelle (font-weight-markierte rechte Zelle — nur der
 * Rechnungs-Renderer markiert die Summen-Zelle so).
 */
function extractInvoiceLineTotals(html: string): number[] {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  const matches = [...tbody.matchAll(/font-weight:[^>]*>\s*([\d.]*\d,\d{2})\s*€/g)];
  return matches.map((m) => parseDeEuroToCents(m[1]));
}

/**
 * Liest den im „Gesamtbetrag"-Total ausgewiesenen Betrag. Funktioniert für
 * beide Renderer (Rechnung + Leistungsnachweis), da beide das Muster
 * `Gesamtbetrag…:</td><td …>BETRAG €` rendern.
 */
function extractGrossTotal(html: string): number {
  const m = html.match(/Gesamtbetrag[^<]*:<\/td>\s*<td[^>]*>\s*([\d.]*\d,\d{2})\s*€/);
  if (!m) throw new Error("Gesamtbetrag-Zeile nicht gefunden");
  return parseDeEuroToCents(m[1]);
}

function makeLineItem(over: Partial<InvoicePdfData["lineItems"][0]> = {}): InvoicePdfData["lineItems"][0] {
  return {
    appointmentId: 1,
    appointmentDate: "2026-01-05",
    startTime: "10:00",
    endTime: "11:00",
    serviceDescription: "Betreuung",
    serviceCode: "betreuung",
    durationMinutes: 60,
    quantityRaw: 1,
    quantityUnit: "hours",
    unitPriceCents: 100,
    totalCents: 100,
    employeeName: "Mitarbeiter A",
    appointmentNotes: null,
    serviceDetails: null,
    ...over,
  };
}

function makeData(over: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    companyName: "CarePflege GmbH",
    companyAddress: "Musterstr. 1, 10115 Berlin",
    companyPhone: "030123456",
    companyEmail: "info@example.com",
    companyWebsite: null,
    steuernummer: null,
    ustId: null,
    iban: "DE00000000000000000000",
    bic: "TESTDEBB",
    bankName: "Testbank",
    bankAccountHolder: null,
    ikNummer: null,
    geschaeftsfuehrer: null,
    invoiceNumber: "RE-2026-0001",
    invoiceDate: "06.01.2026",
    invoiceDueDate: null,
    buyerReference: null,
    invoiceType: "rechnung",
    billingType: "pflegekasse_gesetzlich",
    budgetType: "entlastungsbetrag_45b",
    billingMonth: 1,
    billingYear: 2026,
    recipientName: "Max Mustermann",
    recipientAddress: "Kundenweg 2, 10115 Berlin",
    insuranceProviderName: "AOK",
    insuranceIkNummer: null,
    versichertennummer: null,
    pflegegrad: 3,
    customerName: "Max Mustermann",
    customerAddress: "Kundenweg 2, 10115 Berlin",
    customerGeburtsdatum: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    lineItems: [makeLineItem()],
    netAmountCents: 100,
    vatAmountCents: 0,
    grossAmountCents: 100,
    vatRate: 0,
    notes: null,
    ...over,
  };
}

describe("Renderer #2 — steuerbefreiter Topf (Task #997)", () => {
  // Ein korrekt gebuchter §45b-Topf trägt vat=0. Wir setzen zusätzlich einen
  // Legacy-Artefakt-USt-Betrag (4 ct), um zu beweisen, dass der Renderer ihn in
  // der Anzeige NICHT mehr als USt-Krümel ausgibt (RE-2026-0023).
  const exemptData = makeData({
    budgetType: "entlastungsbetrag_45b",
    billingType: "pflegekasse_gesetzlich",
    vatAmountCents: 4, // Legacy-Artefakt
    vatRate: 0,
    netAmountCents: 100,
    grossAmountCents: 100,
  });

  it("Rechnung: zeigt § 4 Nr. 16 UStG-Befreiung, KEINEN USt-Ausweis", () => {
    const html = generateInvoiceHtml(exemptData);
    expect(html).toContain("Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG");
    expect(html).not.toContain("USt.");
    expect(html).not.toContain("(brutto)");
    expect(html).not.toContain("(inkl. MwSt.)");
  });

  it("Rechnung: netto === brutto (kein ×1,19 auf steuerbefreitem Topf)", () => {
    const html = generateInvoiceHtml(exemptData);
    expect(extractGrossTotal(html)).toBe(exemptData.netAmountCents);
    expect(extractInvoiceLineTotals(html).reduce((s, v) => s + v, 0)).toBe(exemptData.netAmountCents);
  });
});

describe("Renderer #1 — Σ(Zeilen) === Gesamtbetrag bei 19 % (Task #997)", () => {
  // Drei Zeilen à 3 ct: per-Zeile round(3*0,19)=1 ⇒ Σ=3 (alter ×1,19-Bug),
  // korrekt aber: round(9*0,19)=2 USt, Gesamt 11 ct. Largest-Remainder verteilt
  // 2 ct ⇒ Brutto-Zeilen [4,4,3] = 11.
  const standardData = makeData({
    billingType: "selbstzahler",
    budgetType: "private",
    lineItems: [
      makeLineItem({ appointmentId: 1, unitPriceCents: 3, totalCents: 3 }),
      makeLineItem({ appointmentId: 2, unitPriceCents: 3, totalCents: 3 }),
      makeLineItem({ appointmentId: 3, unitPriceCents: 3, totalCents: 3 }),
    ],
    netAmountCents: 9,
    vatAmountCents: 2,
    grossAmountCents: 11,
    vatRate: 1900,
  });

  it("Rechnung: Σ(Brutto-Zeilen) === ausgewiesener Gesamtbetrag (11 ct)", () => {
    const html = generateInvoiceHtml(standardData);
    const lineTotals = extractInvoiceLineTotals(html);
    const gross = extractGrossTotal(html);
    expect(gross).toBe(11);
    expect(lineTotals.reduce((s, v) => s + v, 0)).toBe(gross);
    // Der alte ×1,19-Bug hätte Σ=12 (4+4+4) erzeugt.
    expect(lineTotals.reduce((s, v) => s + v, 0)).not.toBe(12);
  });

  it("Rechnung: weist 19 % USt und Brutto-Spalten aus", () => {
    const html = generateInvoiceHtml(standardData);
    expect(html).toContain("USt. 19%");
    expect(html).toContain("(brutto)");
    expect(html).toContain("(inkl. MwSt.)");
    expect(html).not.toContain("Umsatzsteuerbefreit");
  });

  it("Leistungsnachweis: ausgewiesener Gesamtbetrag === 11 ct (single-LN Pfad)", () => {
    const html = generateLeistungsnachweisHtml(standardData);
    expect(extractGrossTotal(html)).toBe(11);
  });
});

describe("Renderer — Leistungsnachweis steuerbefreit (Task #997)", () => {
  it("netto === brutto, kein USt-Krümel", () => {
    const exemptData = makeData({ vatAmountCents: 4, grossAmountCents: 100, netAmountCents: 100 });
    const html = generateLeistungsnachweisHtml(exemptData);
    expect(html).not.toContain("(brutto)");
    expect(html).not.toContain("(inkl. MwSt.)");
    expect(extractGrossTotal(html)).toBe(100);
  });
});
