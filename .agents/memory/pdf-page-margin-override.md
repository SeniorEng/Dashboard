---
name: PDF @page margin overrides page.pdf({margin})
description: Why invoice/LN PDFs went edge-to-edge and how the margin SSoT actually reaches Chromium
---

# Chromium `@page { margin }` beats `page.pdf({ margin })`

If a document template's CSS contains `@page { margin: 0 }` (or any margin), Chromium's
print engine lets the CSS `@page` margin WIN over the margins passed to Puppeteer's
`page.pdf({ margin })`. Result: invoice/Leistungsnachweis PDFs render edge-to-edge even
though `INVOICE_PDF_MARGIN` / `LEISTUNGSNACHWEIS_PDF_MARGIN` (SSoT in
`shared/domain/document-page-geometry.ts`) are set.

**Why:** the configured page margins are applied via `generatePdf(html, { margin })` in
`server/lib/pdf-generator.ts`. A stray `@page` margin in the inline template CSS silently
neutralizes them.

**How to apply:** the `@page` rule in the templates must be `@page { size: A4; }` with NO
margin declaration. Margins come ONLY from `page.pdf({ margin })`. Regression guard:
`tests/billing/invoice-pdf-margins.test.ts` (renders a full-bleed background, measures the
painted content box ratio against the configured margin ratio, plus a static check that the
`@page` rule has `size:A4` and no `margin`). Note: the footer is a Puppeteer
`footerTemplate`, not a body div — measure the content box WITHOUT the footer (the footer
paints a full-width rect that masks the body box), and assert orphan-page-free separately.

CSS comments inside the JS template literals in `server/lib/pdf-generator.ts` must NOT
contain backticks — they break esbuild's server bundle.
