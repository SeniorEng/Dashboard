/**
 * Task #728 (Phase 2.1) — Architektur-Test: Die Legacy-Tabelle
 * `customer_budgets` ist als Read-Quelle abgeschaltet (SSoT =
 * `customer_budget_type_settings`). Neue Aufrufer von `customerBudgets`
 * (Drizzle-Schema-Tabelle) DÜRFEN NICHT entstehen.
 *
 * Allowlist pro Datei (mit Begründung):
 *  - shared/schema/budget.ts            → Schema-Definition selbst.
 *  - server/lib/customer-creation-helpers.ts → ruft den No-Op-Writer im
 *      Legacy-Pfad (prospects.ts) auf; bleibt bis der Pfad SSoT-only ist.
 *  - server/scripts/cleanup-test-data.ts → Test-Cleanup-Skript löscht
 *      Bestandszeilen.
 *  - server/routes/admin/test-cleanup.ts → Admin-Endpunkt für dasselbe
 *      Cleanup.
 *  - server/routes/admin/customers/duplicates.ts → Dup-Merge zählt
 *      Bestandszeilen für die Anzeige.
 *  - scripts/budget-summary-test.ts → Maintenance-Skript (manueller Lauf).
 *  - server/startup/backfill-customer-budgets-to-typesettings.ts →
 *      einmalige Backfill-Migration, die die Tabelle entleert (Roh-SQL).
 *
 * Failure-Modus: Test schlägt mit der Liste neuer Dateien fehl. Behebung:
 * Aufrufer auf SSoT umstellen oder in der Allowlist eintragen MIT Begründung.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

const ALLOWLIST: ReadonlyArray<string> = [
  "shared/schema/budget.ts",
  "server/lib/customer-creation-helpers.ts",
  "server/scripts/cleanup-test-data.ts",
  "server/routes/admin/test-cleanup.ts",
  "server/routes/admin/customers/duplicates.ts",
  "scripts/budget-summary-test.ts",
  "server/startup/backfill-customer-budgets-to-typesettings.ts",
  // Erklärende Task-#728-Kommentare nennen `customer_budgets` als
  // Begründung für die Fallback-Entfernung / Backfill-Verdrahtung — kein
  // aktiver Read/Write.
  "server/index.ts",
  "server/storage/budget/allocation-storage.ts",
];

const SCAN_ROOTS = ["client/src", "server", "shared", "scripts"];
const EXTS = new Set([".ts", ".tsx"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (EXTS.has(full.slice(full.lastIndexOf(".")))) {
      out.push(full);
    }
  }
}

describe("Architektur — `customer_budgets` ist abgeschaltete Read-Quelle (Task #728 Phase 2.1)", () => {
  it("Keine neuen Aufrufer von `customerBudgets` oder `customer_budgets` außerhalb der Allowlist", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(ROOT, root), files);
    }

    // Treffer: Datei nennt `customerBudgets` als Identifier (Drizzle-Schema-
    // Referenz) ODER `customer_budgets` als rohen SQL-Tabellennamen.
    // Heuristik vermeidet False-Positives auf `customerBudgetTypeSettings`
    // / `customerBudgetPreferences` durch negativen Lookahead.
    const tableRe = /\bcustomerBudgets\b(?!TypeSettings|Preferences)|\bcustomer_budgets\b/;
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (rel.startsWith("tests/")) continue;
      const content = readFileSync(file, "utf-8");
      if (tableRe.test(content)) hits.push(rel);
    }

    const unexpected = hits.filter(h => !ALLOWLIST.includes(h));
    expect(unexpected).toEqual([]);
  });
});
