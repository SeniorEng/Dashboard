// Single source of truth for the PDF page geometry (margins) and the legal/
// company footer line of generated invoices (Rechnungen) and Leistungsnachweise.
//
// The document HTML produced by `server/lib/pdf-generator.ts` intentionally sets
// `@page { margin: 0 }` and `body { margin: 0; padding: 0 }` — the effective page
// margins and the repeating footer are applied by Puppeteer via
// `page.pdf({ margin, footerTemplate })` (see `invoice-pdf-orchestrator.ts`).
//
// Because of that, an on-screen HTML preview of these documents would otherwise
// "lose" the margins and footer the real PDF has. Both the server (PDF) and the
// client (preview) import the values below so the preview can reproduce the same
// framing and they can never drift apart.

import { formatPhoneForDisplay } from "@shared/utils/phone";

export interface DocumentPageMargin {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

// Must mirror the margins handed to `page.pdf({ margin })` in
// `server/services/invoice-pdf-orchestrator.ts`.
export const INVOICE_PDF_MARGIN: DocumentPageMargin = {
  top: "20mm",
  right: "15mm",
  bottom: "20mm",
  left: "15mm",
};

export const LEISTUNGSNACHWEIS_PDF_MARGIN: DocumentPageMargin = {
  top: "15mm",
  right: "15mm",
  bottom: "18mm",
  left: "15mm",
};

export const ZERO_PAGE_MARGIN: DocumentPageMargin = {
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
};

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

export type DocumentPdfType = "invoice" | "leistungsnachweis";

export function getDocumentPageMargin(type: DocumentPdfType): DocumentPageMargin {
  return type === "invoice" ? INVOICE_PDF_MARGIN : LEISTUNGSNACHWEIS_PDF_MARGIN;
}

// Identical to the helper in `server/lib/pdf-generator.ts` so the footer inner
// HTML produced here is byte-for-byte what the PDF footer already renders.
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface InvoiceFooterFields {
  companyName: string | null;
  geschaeftsfuehrer: string | null;
  steuernummer: string | null;
  ustId: string | null;
}

export interface LeistungsnachweisFooterFields {
  companyName: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
}

// Footer inner content for invoices: company · Geschäftsführer · St.-Nr. · USt-ID.
export function buildInvoiceFooterInnerHtml(f: InvoiceFooterFields): string {
  return (
    `${escapeHtml(f.companyName || "")}` +
    `${f.geschaeftsfuehrer ? ` &middot; Geschäftsführer: ${escapeHtml(f.geschaeftsfuehrer)}` : ""}` +
    `${f.steuernummer ? ` &middot; St.-Nr. ${escapeHtml(f.steuernummer)}` : ""}` +
    `${f.ustId ? ` &middot; USt-ID ${escapeHtml(f.ustId)}` : ""}`
  );
}

// Footer inner content for Leistungsnachweise: company | address | phone | email.
export function buildLeistungsnachweisFooterInnerHtml(f: LeistungsnachweisFooterFields): string {
  const parts = [
    escapeHtml(f.companyName || ""),
    escapeHtml(f.companyAddress || ""),
    f.companyPhone ? `Tel.: ${escapeHtml(formatPhoneForDisplay(f.companyPhone))}` : "",
    escapeHtml(f.companyEmail || ""),
  ].filter(Boolean);
  return parts.join(" | ");
}

/**
 * Wrap a full document HTML string so an on-screen iframe preview reproduces the
 * same A4 page framing the generated PDF has: a centered white A4 page on a gray
 * backdrop, the per-document-type page margins applied as body padding, and the
 * repeating PDF footer line drawn inside the reserved bottom margin.
 *
 * The document HTML sets `body { margin: 0; padding: 0 }`; the injected styles
 * use `!important` to re-add the real margins for the preview only. Pure string
 * transform so it can be unit tested without a DOM.
 */
export function frameDocumentHtmlForPreview(
  html: string,
  opts: { margins: DocumentPageMargin; footerInnerHtml?: string },
): string {
  const { margins, footerInnerHtml } = opts;
  const frameStyle =
    `<style data-preview-frame="1">` +
    `html{background:#e5e7eb !important;margin:0 !important;padding:24px 0 !important;}` +
    `body{box-sizing:border-box !important;width:${A4_WIDTH_MM}mm !important;max-width:100% !important;` +
    `min-height:${A4_HEIGHT_MM}mm !important;margin:0 auto !important;background:#ffffff !important;` +
    `box-shadow:0 1px 6px rgba(0,0,0,0.18) !important;position:relative !important;` +
    `padding:${margins.top} ${margins.right} ${margins.bottom} ${margins.left} !important;}` +
    `.__doc-preview-footer{position:absolute;left:${margins.left};right:${margins.right};` +
    `bottom:6mm;font-size:8pt;color:#4b5563;font-family:Arial,Helvetica,sans-serif;` +
    `border-top:1px solid #e5e7eb;padding-top:4px;text-align:center;-webkit-print-color-adjust:exact;}` +
    `</style>`;

  let out = html;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${frameStyle}</head>`);
  } else {
    out = frameStyle + out;
  }

  if (footerInnerHtml) {
    const footer = `<div class="__doc-preview-footer">${footerInnerHtml}</div>`;
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${footer}</body>`);
    } else {
      out = out + footer;
    }
  }

  return out;
}
