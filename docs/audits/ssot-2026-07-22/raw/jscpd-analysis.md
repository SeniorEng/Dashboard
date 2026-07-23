# jscpd Copy-Paste Clone Audit — CareConnect (/home/user/Dashboard)

Run: `npx jscpd client/src server shared --min-tokens 70` (ignoring `components/ui`, `*.test.*`, `replit_integrations`, `node_modules`). Report JSON: `scratchpad/jscpd/jscpd-report.json`. Date: 2026-07-22.

## 1. Overall statistics

| Scope | Files | Lines | Clones | Dup. lines | Dup. tokens |
|---|---|---|---|---|---|
| **Total** | 722 | 184,352 | **297** | 4,414 (**2.39%**) | 33,176 (**3.14%**) |
| typescript (.ts) | 507 | 122,968 | 226 | 3,364 (2.74%) | 25,361 (3.82%) |
| tsx | 214 | 61,221 | 71 | 1,050 (1.72%) | 7,815 (2.01%) |
| css | 1 | 163 | 0 | 0 | 0 |

Per top-level root (clone-side involvement; each clone has 2 sides, so raw sums are ~2x the jscpd de-duplicated total — halve for an effective rate):

| Root | Analyzed lines | Clone-sides | Dup-line-sides | Effective dup rate (approx.) |
|---|---|---|---|---|
| server | 96,049 | 417 | 6,329 | **~3.3%** |
| client/src | 72,776 | 158 | 2,300 | ~1.6% |
| shared | 16,239 | 19 | 196 | ~0.6% |

Within-root clones: server 207, client 79, shared 8; only 3 cross-root clones. **The hotspot is `server/scripts/` + `server/startup/` (one-off reconcile/migration scripts) and two large route files.** `shared/` — where the SSoT logic lives — is nearly clone-free, which is good: the duplication problem is at the *call sites*, not in the domain layer.

Top file *pairs* by total duplicated lines (all clones between the pair summed):

| Dup lines / clones | Pair |
|---|---|
| 424 / 25 | client customer-documents-section-admin.tsx ↔ employee-documents-section.tsx |
| 215 / 14 | server/routes/billing.ts ↔ **itself** |
| 204 / 10 | scripts/reconcile-phantom-stornos.ts ↔ reconcile-reversal-chains.ts |
| 197 / 5 | scripts/regenerate-clobbered-invoice-pdfs.ts ↔ restore-legacy-invoice-pdfs-from-backup.ts |
| 174 / 6 | scripts/reconcile-forbidden-private-invoices.ts ↔ reconcile-phantom-pot-invoices.ts |
| 156 / 9 | digital-document-flow-admin.tsx ↔ digital-document-flow.tsx |
| 90 / 3 | routes/customers/service-prices.ts ↔ routes/standard-prices.ts |

## 2. Top clones, classified

Legend: **DANGEROUS** = real business logic clone (divergence changes money/booking/policy behavior). **CONSOLIDATE** = near-identical scaffolding worth extracting. **ACCEPTABLE** = boilerplate.

1. **73L** `server/scripts/reconcile-forbidden-private-invoices.ts:250` ↔ `reconcile-phantom-pot-invoices.ts:252` — **DANGEROUS.** Entire `stornoInvoiceDocumentOnly()` duplicated: storno invoice creation with field-by-field copy of ~30 invoice columns, sign-negation of amount cents, line-item mirroring, due-date derivation. Any new invoice column or storno rule must be edited in ≥2 places or the scripts silently produce incomplete stornos. Belongs in one shared storno builder (service or shared/domain).

2. **72L** `server/scripts/regenerate-clobbered-invoice-pdfs.ts:273` ↔ `restore-legacy-invoice-pdfs-from-backup.ts:258` — **CONSOLIDATE.** Candidate-invoice loader (Drizzle query over renderSnapshot/pdfHash) + `assertSuperadminOrThrow()`. Script harness; the superadmin guard alone is copy-pasted across ≥4 scripts.

3. **61L** `server/scripts/reconcile-phantom-pot-invoices.ts:186` ↔ `report-wrong-paragraph-kasse-invoices.ts:163` — **DANGEROUS.** `loadAppointmentIdsForInvoice()` + `loadLedgerForAppointments()` — a re-implemented budget-ledger reader whose own doc comment admits it is "dieselbe Quelle/Form wie `getBudgetSplitForAppointments`". Direct violation of the "ONE budget-availability reader" SSoT: a shape change in the canonical reader will not propagate here.

4. **58L** (66L total) `server/scripts/cleanup-test-data.ts:570` ↔ `server/services/test-data-cleanup.ts:515` — **CONSOLIDATE (high drift risk).** The giant FK-cleanup SQL cascade (DELETE/UPDATE … SET NULL over ~40 tables) exists in both a one-off script and a production service, already with small divergences (GoBD bypass flags vs FOR UPDATE lock). Every new table with a user FK must be added twice. The script should call the service.

5. **53L** `regenerate-clobbered-invoice-pdfs.ts:133` ↔ `restore-legacy-invoice-pdfs-from-backup.ts:134` — **CONSOLIDATE.** Shared re-render harness types/options for the two PDF-restore scripts.

6. **51L** `server/startup/cleanup-orphan-erstberatung-customers.ts:45` ↔ `startup/migrate-erstberatung-customers.ts:53` — **DANGEROUS (moderate).** Customer row load + the Vorname/Nachname splitting heuristic (fallback parsing of `name` into first/last with "(unbekannt)" placeholders). That name-normalization rule is business logic; two copies can diverge on edge cases.

7. **45L** `reconcile-forbidden-private-invoices.ts:348` ↔ `reconcile-phantom-pot-invoices.ts:375` — **CONSOLIDATE.** Apply-loop: storno + `persistInvoicePdf` with background-persist fallback + summary assembly. Same harness pattern as #2/#10.

8. **43L** (424L/25 clones for the pair) `client/src/features/customers/components/admin/customer-documents-section-admin.tsx:639` ↔ `features/team/components/employee-documents-section.tsx:671` — **CONSOLIDATE.** Biggest pair in the repo: two ~700-line document-section components (customer-admin vs employee) share grouping, expand/collapse, download anchors, "Digital erstellte Dokumente" block. Pure UI scaffolding, but 25 clone fragments means every UX fix is a double edit. Extract a shared `DocumentsSection`.

9. **40L** `reconcile-phantom-stornos.ts:288` ↔ `reconcile-reversal-chains.ts:256` — **CONSOLIDATE.** Summary building + `main()` + local `eur()` formatter. Note: `function eur(cents)` is copy-pasted in **6** server scripts — a micro-violation of the money-formatting SSoT; use the shared cents formatter.

10. **39L** `reconcile-phantom-stornos.ts:45` ↔ `reconcile-reversal-chains.ts:47` — **CONSOLIDATE.** `parseArgs()` (`--apply/--customer/--user/--reason`) + `assertSuperadminOrThrow()` CLI harness. With #2/#7/#9: extract one `server/scripts/lib/reconcile-harness.ts`.

11. **34L** `server/routes/customers/service-prices.ts:10` ↔ `server/routes/standard-prices.ts:40` — **DANGEROUS.** `rawDateToISO()`, `PriceConflictError`, `isUniqueViolation()` duplicated across the two price routes — price-domain plumbing living in route files twice.

12. **33L** `regenerate-clobbered-invoice-pdfs.ts:561` ↔ `restore-legacy-invoice-pdfs-from-backup.ts:498` — **ACCEPTABLE/CONSOLIDATE.** `main()` console summary output.

13. **32L** (156L/9 clones for the pair) `digital-document-flow-admin.tsx:293` ↔ `digital-document-flow.tsx:258` — **CONSOLIDATE.** Admin and employee variants of the same digital-document dialog (template select, loading states). 9 fragments — the two flows will diverge in behavior, not just style.

14. **32L** `service-prices.ts:620` ↔ `standard-prices.ts:462` — **DANGEROUS.** Price-validity **timeline stitching on delete** (re-open previous price's `valid_to` to the next future price or NULL, else close at today). This is the "ONE price function" business rule implemented twice inside two route handlers; a fix to gap/overlap handling in one route silently misses the other.

15. **30L** (58L/2 clones) `server/routes/appointment-documentation.ts:33` ↔ `:374` (same file) — **DANGEROUS.** Documentation path vs customer-no-show path each re-implement the ALREADY_COMPLETED guard + lock/month-closed lookup + `policyCanDocument` invocation + the Task #1172 error mapping (comment literally says "identische Unterscheidung wie im Dokumentations-Pfad"). Should be one `assertDocumentable(appointment, user)` helper — otherwise the two entry points drift on policy.

16. **30L** `scripts/diff-net-available-45b-forecast.ts:58` ↔ `diff-net-available-45b.ts:87` — **CONSOLIDATE.** `collect45bCustomerIds()` duplicated across the two read-only diff scripts (moderate: it defines which customers count as §45b — a semi-business definition).

**Bonus finding — `server/routes/billing.ts` self-duplication (215L / 14 internal clones): DANGEROUS.** Two invoice-send code paths (~L991ff and ~L1810ff, plus blocks at 2337–3069) each implement the PDF cache-or-render sequence, ZUGFeRD strict-mode `ZugferdEmbedError` handling, and the `invoice_zugferd_embed_failed` audit log. Two send flows that must behave identically for compliance are maintained by copy-paste inside a 3,000-line route file.

## 3. Assessment

- Overall 2.4% duplicated lines is *low* in absolute terms — the SSoT discipline in `shared/` is working (0.6% effective).
- The risk concentrates in three patterns:
  1. **One-off reconcile/migration scripts re-implementing domain operations** (storno creation, budget-ledger reads, §45b customer selection) instead of importing services — the exact "duplicate after the fact" pain the team reports. ~60% of server duplication is under `server/scripts/` + `server/startup/`.
  2. **Paired routes / paired flows** (service-prices vs standard-prices, billing send-paths, appointment-documentation vs no-show) where the second endpoint copied the first's business rules inline.
  3. **Admin-vs-employee UI twins** (documents sections, digital-document-flow) — lower risk but the largest raw volume.
- Remediation levers: (a) shared `scripts/lib` harness (args/superadmin/eur/summary) — removes ~½ of script duplication mechanically; (b) move storno-builder, ledger-reader, price-timeline-stitch into `services`/`shared/domain` and forbid `db.select` on `budget_transactions`/`invoices` outside storage via an ast-grep architecture guard; (c) jscpd in CI with a ratchet (fail on new clones: `--threshold` + committed baseline) so new duplication is caught at PR time, matching the existing gate style.
