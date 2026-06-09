---
name: ZUGFeRD EN-16931 + PDF/A-3b conformance gotchas
description: node-zugferd header-settlement key names, array shapes, XMP namespace repair, and BR-E Steuernummer needed to actually pass Mustang/veraPDF
---

The `validate:erechnung` gate was wired long before the produced invoice actually
passed the official validators (it silently skipped without local Java). Making it
truly conformant required several non-obvious node-zugferd quirks. All are gated
behind the render-snapshot flag `includeConformantSettlement` so already-sealed
invoices re-render byte-identically (GoBD).

**Why:** the friendly-looking keys that work at LINE level are silently dropped at
HEADER level by node-zugferd, so IBAN/VAT-breakdown never reached the XML and
Mustang failed EN-16931 schematron — invisible because the gate skipped without Java.

**How to apply** — when touching `buildZugferdData` header `tradeSettlement` or the
sample in `scripts/validate-erechnung.ts`:

- Header (BG-level) settlement keys are NOT the line keys. Use
  `paymentInstruction` (BG-16; `typeCode`, `transfers`) and `vatBreakdown` (BG-23),
  NOT the line-level `paymentMeans`/`tradeTax`. node-zugferd drops the wrong header
  keys without error.
- `transfers` AND `vatBreakdown` are `object[]` in the node-zugferd profile schema
  (type `"object[]"`). Pass them as ARRAYS even with one element. A single object
  gets its contents dropped — e.g. a missing `IBANID` then trips Mustang `BR-CO-27`
  ("IBAN or Proprietary ID, not both/neither"). The error wording when wrong is
  `"<field> - Expected array, received object"`.
- `transfers[].paymentAccountIdentifier` maps to `ram:...PayeePartyCreditorFinancialAccount/ram:IBANID` (BT-84).
- PDF/A-3b: node-zugferd writes a broken XMP root `xmlns:about=""` instead of
  `rdf:about=""`. Repair it length-preserving (both tokens are 14 bytes) so the PDF
  xref byte-offsets stay valid; otherwise veraPDF fails PDF/A-3b. Helper:
  `repairZugferdXmpNamespace`.
- VAT-exempt Pflegekasse invoices use tax category E. EN-16931 `BR-E-2` requires
  seller VAT-ID (BT-31) OR tax number (BT-32). Care services usually have no VAT-ID,
  so the company `steuernummer` MUST be populated or Mustang fails. `BR-E-10` needs
  an `exemptionReasonText` (BT-120).

**Validator provisioning to verify locally (not in default dev container):**
PATH must include a JDK (graalvm19 nix store bin). Mustang CLI = shaded jar from
Maven Central `org/mustangproject/Mustang-CLI`. veraPDF = IzPack auto-install; the
installer launcher lives at `verapdf-greenfield-<ver>/verapdf-install`, not at the
zip root. Run:
`MUSTANG_CLI_JAR=... VERAPDF_CLI=.../verapdf/verapdf ERECHNUNG_REQUIRE_VALIDATORS=1 npm run validate:erechnung`.

**Sample carrier PDF for the gate:** must NOT draw text with pdf-lib
`StandardFonts` — the standard-14 fonts are not embedded and break PDF/A (all
glyphs must be embedded). Use a blank A4 carrier page; the gate only checks the
node-zugferd XML/embedding/PDF-A structure, the real visible invoice is Chromium
(embedded fonts).
