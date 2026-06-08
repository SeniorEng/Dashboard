---
name: ZUGFeRD profile default (EN 16931) & GoBD re-render safety
description: Why new invoices embed EN 16931 but already-sealed ones must re-render as BASIC; how the non-strict fallback is logged and how the validation gate skips.
---

# ZUGFeRD profile: EN 16931 default, but sealed invoices re-render as BASIC

`DEFAULT_ZUGFERD_PROFILE="en16931"` (`server/lib/zugferd.ts`). New invoices
embed EN 16931 CII XML. The build/embed functions carry a `profile` and the
seal snapshot persists `snapshot.profile` (`shared/schema/billing.ts`).

**Rule:** if `snapshot.profile` is undefined (invoice sealed before this change),
the orchestrator MUST re-render as `"basic"`, never EN 16931.

**Why:** GoBD byte-determinism. A re-render of an already-sealed invoice must
reproduce the sealed `pdf_hash`; switching the embedded XML profile changes the
bytes and would flag every legacy invoice as tampered. Upgrading the historical
estate is a deliberate deferred, audit-logged correction — not a silent
re-render. (See follow-up: backfill older invoices to EN 16931.)

**How to apply:** any new re-render / verify / repair path that selects a
ZUGFeRD profile must read it from the seal snapshot and default to `"basic"`
when absent. Don't hardcode `DEFAULT_ZUGFERD_PROFILE` on the re-render path.

## Non-strict fallback is audit-logged, not silent
node-zugferd strict validation can fail for legitimate edge data; we fall back
to non-strict embedding rather than hard-rejecting the invoice, and record an
audit entry `invoice_zugferd_nonstrict_seal` (action in `shared/schema/audit.ts`,
emitted via `logZugferdNonStrictSeal` in the orchestrator). Do NOT turn this
into a hard error without a product decision.

## Validation gate skips cleanly without Java
`scripts/validate-erechnung.ts` (`npm run validate:erechnung`) builds a sample
EN16931 PDF/A-3 with a pdf-lib carrier + embedZugferdXml (NO Chromium), then
runs Mustang/KoSIT EN-16931 Schematron + veraPDF PDF/A-3 only when
`MUSTANG_CLI_JAR`/`VERAPDF_CLI` are set and Java is present. Exit 0 = skip,
1 = validation fail, 2 = pipeline defect. `ERECHNUNG_REQUIRE_VALIDATORS=1`
forces validators to be present (used by the CI `erechnung-validation` job).
Run probe scripts from the project root.
