import { describe, it, expect } from "vitest";
import {
  INVOICE_PDF_MARGIN,
  LEISTUNGSNACHWEIS_PDF_MARGIN,
  getDocumentPageMargin,
  buildInvoiceFooterInnerHtml,
  buildLeistungsnachweisFooterInnerHtml,
  frameDocumentHtmlForPreview,
} from "@shared/domain/document-page-geometry";

describe("document-page-geometry — SSoT margins", () => {
  it("invoice margins match the documented PDF geometry (20mm top/bottom, 15mm left/right)", () => {
    expect(INVOICE_PDF_MARGIN).toEqual({ top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" });
  });

  it("Leistungsnachweis margins match the documented PDF geometry (15mm top, 18mm bottom, 15mm left/right)", () => {
    expect(LEISTUNGSNACHWEIS_PDF_MARGIN).toEqual({ top: "15mm", right: "15mm", bottom: "18mm", left: "15mm" });
  });

  it("getDocumentPageMargin returns the matching margin per type", () => {
    expect(getDocumentPageMargin("invoice")).toEqual(INVOICE_PDF_MARGIN);
    expect(getDocumentPageMargin("leistungsnachweis")).toEqual(LEISTUNGSNACHWEIS_PDF_MARGIN);
  });
});

describe("document-page-geometry — footer inner content (SSoT shared with PDF)", () => {
  it("invoice footer reproduces the legacy company / Geschäftsführer / St.-Nr. / USt-ID line", () => {
    const out = buildInvoiceFooterInnerHtml({
      companyName: "Pflege & Co GmbH",
      geschaeftsfuehrer: "Max Müller",
      steuernummer: "12/345/67890",
      ustId: "DE123456789",
    });
    expect(out).toBe(
      "Pflege &amp; Co GmbH &middot; Geschäftsführer: Max Müller &middot; St.-Nr. 12/345/67890 &middot; USt-ID DE123456789",
    );
  });

  it("invoice footer omits optional segments when absent", () => {
    expect(buildInvoiceFooterInnerHtml({ companyName: "Acme", geschaeftsfuehrer: null, steuernummer: null, ustId: null })).toBe("Acme");
  });

  it("Leistungsnachweis footer reproduces the legacy company | address | phone | email line", () => {
    const out = buildLeistungsnachweisFooterInnerHtml({
      companyName: "Pflege & Co GmbH",
      companyAddress: "Hauptstr. 1, 12345 Berlin",
      companyPhone: "+49 30 1234567",
      companyEmail: "info@pflege.de",
    });
    expect(out).toBe(
      "Pflege &amp; Co GmbH | Hauptstr. 1, 12345 Berlin | Tel.: 030 1234567 | info@pflege.de",
    );
  });

  it("Leistungsnachweis footer drops empty fields", () => {
    expect(
      buildLeistungsnachweisFooterInnerHtml({ companyName: "Acme", companyAddress: null, companyPhone: null, companyEmail: null }),
    ).toBe("Acme");
  });
});

describe("document-page-geometry — preview framing", () => {
  const DOC = "<!DOCTYPE html><html><head><style>@page{margin:0}body{margin:0;padding:0}</style></head><body><h1>Rechnung</h1></body></html>";

  it("applies the page margins as body padding inside the framed A4 page", () => {
    const framed = frameDocumentHtmlForPreview(DOC, { margins: INVOICE_PDF_MARGIN });
    expect(framed).toContain("padding:20mm 15mm 20mm 15mm !important;");
    expect(framed).toContain("width:210mm !important;");
    expect(framed).toContain("min-height:297mm !important;");
    // injected before the closing head and keeps the original document body
    expect(framed).toContain('data-preview-frame="1"');
    expect(framed).toContain("<h1>Rechnung</h1>");
  });

  it("renders the footer inner html inside the framed page when provided", () => {
    const framed = frameDocumentHtmlForPreview(DOC, {
      margins: LEISTUNGSNACHWEIS_PDF_MARGIN,
      footerInnerHtml: "Acme | Hauptstr. 1 | Tel.: 030 1 | info@acme.de",
    });
    expect(framed).toContain('<div class="__doc-preview-footer">Acme | Hauptstr. 1 | Tel.: 030 1 | info@acme.de</div></body>');
    expect(framed).toContain("padding:15mm 15mm 18mm 15mm !important;");
  });

  it("omits the footer element when no footer content is given", () => {
    const framed = frameDocumentHtmlForPreview(DOC, { margins: INVOICE_PDF_MARGIN });
    expect(framed).not.toContain('<div class="__doc-preview-footer">');
  });
});
