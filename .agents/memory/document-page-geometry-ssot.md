---
name: Invoice/LN page geometry SSoT & no HTML preview
description: Where invoice/Leistungsnachweis PDF margins + footer live, and the (surprising) fact that there is no on-screen HTML preview of them.
---

# Invoice / Leistungsnachweis page geometry SSoT

**Surprising fact:** there is NO on-screen HTML preview of invoices (Rechnung) or
Leistungsnachweise. They are rendered server-side to PDF only and shown by opening
the real PDF in a new tab (`invoice-row.tsx` → `<a href="/api/billing/:id/pdf">` and
`/leistungsnachweis`). `generateInvoiceHtml` / `generateLeistungsnachweisHtml`
(`server/lib/pdf-generator.ts`) are used ONLY by the PDF orchestrator. The shared
`DocumentPreview` component is used only for TEMPLATE documents (digital-document-flow,
wizard signatures-step); `public-signing.tsx` renders template docs inline. Don't
spend time hunting for an invoice/LN HTML preview surface — it doesn't exist.

**Why this matters:** the document HTML intentionally sets `@page{margin:0}` and
`body{margin:0;padding:0}`; the real page margins and the repeating footer are applied
by Puppeteer in `invoice-pdf-orchestrator.ts` via `page.pdf({ margin, footerTemplate })`.
So any HTML preview built later would lose the margins/footer unless it re-applies them.

**SSoT:** margins + footer-inner-content now live in
`shared/domain/document-page-geometry.ts` (`INVOICE_PDF_MARGIN`,
`LEISTUNGSNACHWEIS_PDF_MARGIN`, `buildInvoiceFooterInnerHtml`,
`buildLeistungsnachweisFooterInnerHtml`, `frameDocumentHtmlForPreview`). Imported by
the orchestrator (margins) and `pdf-generator.ts` footer builders (inner content), and
by `DocumentPreview` (opt-in framed-A4 preview via `pageMargins`/`footerInnerHtml`).

**How to apply:** any change to invoice/LN margins or the footer line goes in the
shared module so PDF and any preview stay byte-for-byte aligned. The footer inner
builders must keep producing the exact same string the PDF already embeds (escaping +
`formatPhoneForDisplay` double-format on phone), or sealed `pdf_hash` reproduction
breaks. Margins are mobile-sensitive: framing a preview to a fixed 210mm A4 forces
horizontal scroll on phones, so framing is opt-in, not the default for template previews.
