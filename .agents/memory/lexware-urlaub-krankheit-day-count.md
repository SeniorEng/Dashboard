---
name: Lexware Urlaub/Krankheit = day-count only
description: Why the Lexware hours export reports vacation/sick as days, not pay, for minijobbers
---

The Lexware/hours export (`server/routes/admin/lexware-export.ts`) reports minijobber
`urlaub` (vacation) and `krankheit` (sick) ONLY as day counts (`tageUrlaub`/`tageKrankheit`)
and deliberately EXCLUDES them from the wage `bruttoCents`. `PAID_MANUAL_ENTRY_TYPES`
omits both on purpose.

**Why:** The back office confirmed Lexware itself computes the statutory continued pay
(Entgeltfortzahlung / Lohnfortzahlung for vacation/sick days) from those day counts. The
app must NOT supply a euro amount for them — doing so would double-count pay in Lexware.

**How to apply:** Do not "fix" the missing vacation/sick pay by adding it to `bruttoCents`.
The day-count-only behavior is intentional. Only revisit if the back office changes how
Lexware handles Entgeltfortzahlung.
