/**
 * Task #876 — Budget GF Phase 6: Lösch-Gate-Guard für die Legacy-Tabelle
 * `customer_budgets`.
 *
 * Hintergrund: Die eingefrorene Legacy-Tabelle `customer_budgets` und ihre
 * Read-/Write-Fallbacks wurden mit Task #728 (Fallback entfernt) und Task #743
 * (Tabelle per Startup-Migration gedroppt) endgültig stillgelegt. Single-
 * Source-of-Truth für die Topf-Konfiguration ist seither
 * `customer_budget_type_settings` (+ `budget_allocations`/`budget_transactions`
 * für den Ledger).
 *
 * Diese Architektur-Schranke verhindert, dass jemand versehentlich einen
 * neuen Lese-/Schreibpfad gegen `customer_budgets` (Drizzle-Tabelle ODER
 * Raw-SQL) wiederbelebt. Zwei Checks:
 *   1. Der Drizzle-Tabellen-Bezeichner `customerBudgets` darf in produktivem
 *      Code (`server/`, `client/src/`, `shared/`) NICHT mehr vorkommen.
 *   2. Kein Raw-SQL-DML (`FROM/JOIN/INTO/UPDATE customer_budgets`) gegen die
 *      Tabelle. Der `DROP TABLE`-Pfad der Startup-Migration ist erlaubt
 *      (er entfernt die Tabelle, liest/schreibt sie nicht).
 *
 * Failure-Modus: Test schlägt fehl mit Datei:Zeile jedes Treffers. Wer einen
 * Treffer sieht, hat einen `customer_budgets`-Zugriff (re-)eingeführt — die
 * SSoT ist `customer_budget_type_settings`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { ROOT, walkTsFiles } from "./ast-grep-helpers";

// Dateien, die `customer_budgets` legitim nennen dürfen, weil sie die Tabelle
// ausschließlich ENTFERNEN (DROP) — kein Read-/Write-Pfad.
const ALLOWED_FILES = new Set<string>([
  "server/startup/drop-customer-budgets-table.ts",
]);

// camelCase-Drizzle-Tabellen-Bezeichner. Bewusst case-sensitive, damit
// verwandte SSoT-Tabellen (`customerBudgetTypeSettings`,
// `customerBudgetPreferences`, `customerBudgetRecipients`) sowie Backfill-
// Helfernamen (`backfillCustomerBudgets...`) NICHT fälschlich treffen.
const DRIZZLE_TABLE_RE = /\bcustomerBudgets\b/;

// Raw-SQL-DML gegen die Tabelle (Lesen ODER Schreiben). `DROP TABLE … customer_budgets`
// und String-Literale wie `table_name = 'customer_budgets'` matchen bewusst nicht.
const SQL_DML_RE = /\b(?:from|join|into|update)\s+customer_budgets\b/i;

describe("Architektur — keine customer_budgets-Zugriffe (Task #876, Phase 6)", () => {
  it("Kein Drizzle-/SQL-Read-/Write-Pfad gegen die Legacy-Tabelle customer_budgets", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel.startsWith("tests/")) continue;
        if (ALLOWED_FILES.has(rel)) continue;
        const lines = readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (DRIZZLE_TABLE_RE.test(line) || SQL_DML_RE.test(line)) {
            hits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 140) });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — ${h.snippet}`).join("\n");
      expect.fail(
        `Folgende Stellen greifen auf die stillgelegte Legacy-Tabelle 'customer_budgets' zu:\n` +
        `${msg}\n\n` +
        `Die Tabelle wurde mit Task #743 gedroppt. SSoT für Topf-Konfiguration ist ` +
        `'customer_budget_type_settings' (via budgetStorage). Entferne den Zugriff ` +
        `oder — falls die Datei die Tabelle nur droppt — trage sie in ALLOWED_FILES ein.`,
      );
    }
  });
});
