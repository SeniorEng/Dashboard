---
name: Startup imports fire script main()
description: Importing a server/scripts/* module into a startup/runtime path executes any unguarded top-level main() at server boot.
---

A startup migration (or any runtime module) that `await import(...)`s a function out
of a `server/scripts/*` file will execute that script module's **top-level code** at
server boot — including an unconditional `main()` call. If that `main()` ends with
`process.exit(...)`, the server process dies during startup ("Start application" fails).

**Why:** `populate-prices.ts` called `main().then(()=>process.exit(0))` at module load
without a guard. A new gated startup migration imported `populatePricesInto` from it,
so every boot ran the dry-run report and then `process.exit` — killing the server,
even though the migration itself was flag-gated OFF.

**How to apply:** Every `server/scripts/*` CLI module whose exports may be imported by
runtime code MUST guard its entrypoint with
`if (import.meta.url === \`file://${process.argv[1]}\`) { main()... }`.
Sibling scripts (report-price-consolidation-conflicts.ts, shadow-diff-*.ts) already
use this guard; match it. Typecheck/lint will NOT catch this — only a boot of the
"Start application" workflow reveals it.
