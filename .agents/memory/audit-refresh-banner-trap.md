---
name: Audit-refresh "banner over old content" trap
description: Why a full-app audit refresh can report suspiciously few findings — chunks bannered instead of re-walked.
---

# Audit-refresh "banner over old content" trap

When refreshing the chunked full-app audit in `docs/audits/full-app-2026/`, a
refresh wave may deep-dive only the highest-churn chunks and paste a one-line
"Refresh #NNN (Pattern-Scan)" banner over the **old** report body (old commit
hash) for the rest. The chunk file then still says `Commit: <old-hash>` and
`Tiefenstufe: Pattern-Scan`. Those chunks were NOT re-examined against current code.

**Why it matters:** This happened twice (#481 → #822). Each time the headline
severity counts only reflected the deep-dived half, so a "full-app" report
undercounted. The #822 gap-fill on the 14 bannered chunks surfaced 6 additional
verified HOCH findings (admin master-data audit-log gaps, ArbZG auto-break loss on
month reclose, DSGVO plaintext in browser localStorage draft, startup-chain abort).

**How to apply:** Before trusting a refreshed audit's counts, verify coverage:
`for f in chunks/*.md; do head -6 "$f"; done` — any chunk whose header shows the
OLD commit hash or `Pattern-Scan` was bannered, not re-audited. Deep chunks are
also visibly longer (~30-42 lines) than banners (~20-23). Re-walk the bannered
chunks at the current commit before reporting final severity counts.
