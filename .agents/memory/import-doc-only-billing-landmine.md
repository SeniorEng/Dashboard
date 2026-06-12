---
name: Doc-only prior-year import vs billing per-pot split
description: Documentation-only imported appointments have zero consumption rows; the invoice per-pot split treats zero-consumption appointments as private/Selbstzahler-Rest.
---

# Doc-only imported appointments are a billing landmine

Prior-year appointments imported "documentation-only" (the §45b-anchor-floor case)
create a `completed` appointment with notes prefixed `"Import aus Altdaten"` but
deliberately book **zero** `budget_transactions` (no consumption rows).

**The landmine:** the invoice per-pot split in `server/.../invoice-data.ts` treats an
appointment with no consumption rows as "kein Topf-Eintrag → private", i.e. it falls
into the Selbstzahler-Rest bucket. So if an operator ever runs a billing run that
covers a prior-year month containing these doc-only appointments, those customers —
who by definition do **not** accept private payment — would be invoiced as
Selbstzahler. That is wrong.

**Why this is non-obvious:** the import path and the billing path never reference each
other; the coupling is purely emergent through "zero consumption rows == private".

**How to apply:**
- Don't bill prior-year months through the app while doc-only appointments live there,
  OR exclude doc-only (`status='completed'` + zero consumption + notes LIKE
  'Import aus Altdaten%') appointments from billable selection.
- Any new feature that selects appointments for billing/consumption-aggregation must
  decide explicitly how it treats zero-consumption-but-completed appointments — don't
  assume "no rows == self-payer".
- The notes prefix MUST stay `"Import aus Altdaten…"` because
  `createServiceRecordsForImported` matches `LIKE 'Import aus Altdaten%'` to synthesize
  Leistungsnachweise for imported appointments.
