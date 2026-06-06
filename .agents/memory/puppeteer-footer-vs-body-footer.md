---
name: Puppeteer footer vs body-footer
description: Why invoice/LN PDF footers must use Puppeteer footerTemplate, not a body <div>, and the recipe to make it render.
---

# PDF footers: use Puppeteer `footerTemplate`, never a body `<div class="footer">`

A body-level footer div in the invoice/Leistungsnachweis HTML orphans onto a
near-empty extra page when the content height lands close to a page boundary —
the div is normal flow content, so Chromium pushes it to the next page.

**Rule:** repeating document footers (Pflichtangaben / contact line) belong in
Puppeteer's `page.pdf({ displayHeaderFooter:true, footerTemplate })`, drawn in
the reserved bottom margin on every page — not in the document body.

**Recipe (validated on Chromium 125):**
- Set `@page { margin: 0 }` in the HTML and supply the *effective* page margins
  via `page.pdf({ margin })`. The bottom margin must be large enough to hold the
  footer (e.g. 18–20mm) or the footer is clipped/overlaps content.
- `footerTemplate` does NOT see the page's `<style>` — every style must be
  **inline**, and you MUST set an explicit `font-size` (the template default is
  0, so an unstyled footer renders invisible).
- Always pass a non-empty `headerTemplate` (e.g. `<span></span>`) when
  `displayHeaderFooter:true`, otherwise Puppeteer injects its default
  date/title header.

**Why keep a default-off path:** `generatePdf(html, options?)` defaults to the
old zero-margin / no-footer behavior so non-invoice PDF consumers (generated
documents, cover letters, merges) stay byte-identical. Only the invoice/LN
orchestrator opts into the footer.

**Signature render-gate drift (same task):** the render-time signature
validator and the sign-time validator must accept the SAME image formats. A
render gate that only accepted png/jpeg/svg silently dropped jpg/webp
signatures that sign-time accepted. Delegate raster validation to the one shared
`isSignatureImageMeaningful` helper instead of a second hand-rolled allowlist.
