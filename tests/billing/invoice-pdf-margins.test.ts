import { describe, it, expect } from "vitest";
import zlib from "zlib";
import {
  generateInvoiceHtml,
  generateLeistungsnachweisHtml,
  generatePdf,
  buildInvoiceFooterTemplate,
  buildLeistungsnachweisFooterTemplate,
  type InvoicePdfData,
} from "../../server/lib/pdf-generator";
import {
  INVOICE_PDF_MARGIN,
  LEISTUNGSNACHWEIS_PDF_MARGIN,
  ZERO_PAGE_MARGIN,
  A4_WIDTH_MM,
  A4_HEIGHT_MM,
} from "@shared/domain/document-page-geometry";

/**
 * Task #1066 — Regressionswächter für die effektiven Rechnungs-/LN-Seitenränder.
 *
 * Ursprünglicher Bug: Beide Dokument-Templates setzten `@page { margin: 0 }`.
 * Chromiums Print-Engine lässt eine CSS-`@page`-Margin über die an
 * `page.pdf({ margin })` übergebenen Ränder GEWINNEN — die in
 * `INVOICE_PDF_MARGIN`/`LEISTUNGSNACHWEIS_PDF_MARGIN` konfigurierten Ränder
 * waren damit faktisch 0 (Inhalt randlos bis an die Blattkante).
 *
 * Dieser Test rendert die ECHTEN Templates (mit injiziertem Vollflächen-
 * Hintergrund, damit der bemalte Inhaltskasten messbar wird) zweimal: einmal
 * mit Null-Margin, einmal mit der konfigurierten Margin. Der bemalte Kasten
 * MUSS bei der konfigurierten Margin exakt um das Margin-Verhältnis kleiner
 * sein als bei Null-Margin. Die Messung ist einheiten-unabhängig (reines
 * Verhältnis), und sie schlägt sowohl an, wenn `generatePdf` die Margin
 * ignoriert, als auch, wenn jemand erneut `@page { margin: 0 }` einführt
 * (dann gewinnt die @page-Margin und beide Renderings sind randlos → Verhältnis
 * ≈ 1 statt < 1).
 */

function buildPdfData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: "RE-MARGIN-2026-0001",
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

// Injiziert einen Vollflächen-Hintergrund (html+body 100% Höhe, schwarz), damit
// der von Chromium gemalte Inhaltskasten als ein großes `re`-Rechteck im
// Content-Stream messbar wird. Verändert NICHT die @page-/Margin-Regeln des
// Templates — nur den Hintergrund.
function injectFullBleedBackground(html: string): string {
  const style =
    `<style data-margin-probe="1">` +
    `html,body{height:100% !important;background:#000 !important;` +
    `-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}` +
    `</style>`;
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}</head>`)
    : style + html;
}

interface Rect {
  w: number;
  h: number;
}

// Findet das flächengrößte `x y w h re`-Rechteck über alle (Flate-dekodierten)
// Content-Streams des PDFs. Das ist der Vollflächen-Hintergrund = Inhaltskasten.
function findLargestRect(pdf: Buffer): Rect {
  const reRect = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+re\b/g;
  let best: Rect = { w: 0, h: 0 };
  let bestArea = 0;

  const scanText = (text: string) => {
    let m: RegExpExecArray | null;
    reRect.lastIndex = 0;
    while ((m = reRect.exec(text)) !== null) {
      const w = Math.abs(parseFloat(m[3]));
      const h = Math.abs(parseFloat(m[4]));
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = { w, h };
      }
    }
  };

  // Alle `stream ... endstream`-Blöcke einsammeln und dekodieren.
  const streamKw = Buffer.from("stream");
  const endKw = Buffer.from("endstream");
  let idx = 0;
  while (true) {
    const sPos = pdf.indexOf(streamKw, idx);
    if (sPos === -1) break;
    let dataStart = sPos + streamKw.length;
    // EOL nach `stream` überspringen (\r\n oder \n).
    if (pdf[dataStart] === 0x0d) dataStart++;
    if (pdf[dataStart] === 0x0a) dataStart++;
    const ePos = pdf.indexOf(endKw, dataStart);
    if (ePos === -1) break;
    const raw = pdf.subarray(dataStart, ePos);
    idx = ePos + endKw.length;

    let decoded: string | null = null;
    try {
      decoded = zlib.inflateSync(raw).toString("latin1");
    } catch {
      try {
        decoded = zlib.inflateRawSync(raw).toString("latin1");
      } catch {
        decoded = raw.toString("latin1");
      }
    }
    if (decoded) scanText(decoded);
  }
  return best;
}

async function pageCount(pdf: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf);
  return doc.getPageCount();
}

async function measureContentBox(
  html: string,
  margin: { top: string; right: string; bottom: string; left: string },
  footerHtml?: string,
): Promise<Rect> {
  const { buffer } = await generatePdf(html, footerHtml ? { margin, footerHtml } : { margin });
  return findLargestRect(buffer);
}

function mm(value: string): number {
  return parseFloat(value.replace("mm", ""));
}

describe("Task #1066 — effektive Rechnungs-/LN-Seitenränder", () => {
  it("Rechnungs-Template: konfigurierte Margin verkleinert den Inhaltskasten um exakt das Margin-Verhältnis", async () => {
    const html = injectFullBleedBackground(generateInvoiceHtml(buildPdfData()));
    const footer = buildInvoiceFooterTemplate(buildPdfData());

    // Inhaltskasten OHNE Footer messen: Chromium komponiert den
    // displayHeaderFooter-Footer über die volle Seitenbreite und injiziert dabei
    // ein vollflächiges `re`-Rechteck, das den Body-Kasten überdecken würde.
    const full = await measureContentBox(html, ZERO_PAGE_MARGIN);
    const inset = await measureContentBox(html, INVOICE_PDF_MARGIN);

    expect(full.w).toBeGreaterThan(0);
    expect(full.h).toBeGreaterThan(0);

    const expectedWidthRatio = (A4_WIDTH_MM - mm(INVOICE_PDF_MARGIN.left) - mm(INVOICE_PDF_MARGIN.right)) / A4_WIDTH_MM;
    const expectedHeightRatio = (A4_HEIGHT_MM - mm(INVOICE_PDF_MARGIN.top) - mm(INVOICE_PDF_MARGIN.bottom)) / A4_HEIGHT_MM;

    const widthRatio = inset.w / full.w;
    const heightRatio = inset.h / full.h;

    // Inhaltskasten MUSS klar kleiner als randlos sein (fängt @page{margin:0}-Regression).
    expect(widthRatio).toBeLessThan(0.95);
    expect(heightRatio).toBeLessThan(0.95);
    // …und zwar exakt um das konfigurierte Margin-Verhältnis.
    expect(widthRatio).toBeCloseTo(expectedWidthRatio, 1);
    expect(heightRatio).toBeCloseTo(expectedHeightRatio, 1);

    // Kein verdrängter Footer auf eine Leerseite.
    expect(await pageCount((await generatePdf(html, { margin: INVOICE_PDF_MARGIN, footerHtml: footer })).buffer)).toBe(1);
  });

  it("Leistungsnachweis-Template: konfigurierte Margin verkleinert den Inhaltskasten um exakt das Margin-Verhältnis", async () => {
    const html = injectFullBleedBackground(generateLeistungsnachweisHtml(buildPdfData({ billingType: "pflegekasse_privat" })));
    const footer = buildLeistungsnachweisFooterTemplate(buildPdfData({ billingType: "pflegekasse_privat" }));

    // Inhaltskasten OHNE Footer messen (siehe Rechnungs-Test).
    const full = await measureContentBox(html, ZERO_PAGE_MARGIN);
    const inset = await measureContentBox(html, LEISTUNGSNACHWEIS_PDF_MARGIN);

    expect(full.w).toBeGreaterThan(0);
    expect(full.h).toBeGreaterThan(0);

    const expectedWidthRatio = (A4_WIDTH_MM - mm(LEISTUNGSNACHWEIS_PDF_MARGIN.left) - mm(LEISTUNGSNACHWEIS_PDF_MARGIN.right)) / A4_WIDTH_MM;
    const expectedHeightRatio = (A4_HEIGHT_MM - mm(LEISTUNGSNACHWEIS_PDF_MARGIN.top) - mm(LEISTUNGSNACHWEIS_PDF_MARGIN.bottom)) / A4_HEIGHT_MM;

    const widthRatio = inset.w / full.w;
    const heightRatio = inset.h / full.h;

    expect(widthRatio).toBeLessThan(0.95);
    expect(heightRatio).toBeLessThan(0.95);
    expect(widthRatio).toBeCloseTo(expectedWidthRatio, 1);
    expect(heightRatio).toBeCloseTo(expectedHeightRatio, 1);

    // Footer + Margin erzeugen keine verdrängte Leerseite.
    expect(await pageCount((await generatePdf(html, { margin: LEISTUNGSNACHWEIS_PDF_MARGIN, footerHtml: footer })).buffer)).toBe(1);
  });

  it("statischer Wächter: Templates setzen `@page { size: A4 }` ohne `@page`-Margin", () => {
    for (const html of [
      generateInvoiceHtml(buildPdfData()),
      generateLeistungsnachweisHtml(buildPdfData({ billingType: "pflegekasse_privat" })),
    ]) {
      const pageRule = html.match(/@page\s*\{[^}]*\}/i);
      expect(pageRule, "Template muss eine @page-Regel enthalten").not.toBeNull();
      expect(pageRule![0]).toMatch(/size:\s*A4/i);
      // KEINE margin-Deklaration innerhalb der @page-Regel — die würde die
      // page.pdf({ margin })-Ränder in Chromium überstimmen (Task #1066).
      expect(pageRule![0]).not.toMatch(/margin/i);
    }
  });
});
