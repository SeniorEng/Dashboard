/**
 * Task #1238 (Phase 0.2 — Architektur-Wächter) — Append-only-Wächter für
 * `budget_ledger`.
 *
 * `budget_ledger` ist GoBD-immutable / append-only: Korrekturen erfolgen
 * ausschließlich über eine NEUE Gegenbuchung (Storno-Insert), niemals durch
 * Mutation oder Löschung bestehender Zeilen. Dieser Wächter verbietet statisch
 * jeden direkten Drizzle-`db.update(budgetLedger)` / `db.delete(budgetLedger)`
 * sowie rohe `UPDATE budget_ledger` / `DELETE FROM budget_ledger`-SQL.
 *
 * Rein statisch — KEINE Laufzeit-Änderung. Der Detektor ist PUR und wird vom
 * Real-Tree-Scan UND vom Negativ-Test mit DERSELBEN Funktion aufgerufen.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

/**
 * Erlaubte Ausnahmen (repo-relativer Pfad). Bewusst LEER: append-only kennt
 * keinen legitimen UPDATE/DELETE-Pfad auf `budget_ledger`.
 */
const WHITELIST = new Set<string>([]);

/** Drizzle-Schreibpfad: `db.update(budgetLedger)` / `db.delete(budgetLedger)`. */
const DRIZZLE_WRITE_RE = /\.(?:update|delete)\s*\(\s*budgetLedger\b/;

/**
 * Rohes SQL: `UPDATE budget_ledger …` / `DELETE FROM budget_ledger …`.
 * Erfasst auch zitierte (`"budget_ledger"`) und schema-qualifizierte
 * (`public.budget_ledger`) Schreibweisen, damit der Append-only-Schutz nicht
 * trivial umgangen werden kann. Der `\b` direkt hinter `budget_ledger` hält die
 * Regel präzise (matcht NICHT `budget_ledger_archive` o. ä.).
 */
const RAW_SQL_WRITE_RE = /\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?"?budget_ledger\b/i;

export function detectLedgerWritePathViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (WHITELIST.has(rel)) continue;
    const code = stripComments(content);
    if (DRIZZLE_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail: "ruft `db.update/delete(budgetLedger)` auf — budget_ledger ist append-only (Storno = neue Gegenbuchung)",
      });
    }
    if (RAW_SQL_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail: "enthält rohes `UPDATE/DELETE budget_ledger` — budget_ledger ist append-only (Storno = neue Gegenbuchung)",
      });
    }
  }
  return out;
}

describe("Architektur — budget_ledger Append-only-Wächter (Task #1238)", () => {
  it("kein direkter UPDATE/DELETE-Schreibpfad auf budget_ledger", () => {
    const files = collectScanFiles(["server", "shared"]);
    const v = detectLedgerWritePathViolations(files);
    if (v.length > 0) {
      expect.fail(
        "Append-only-Invariante verletzt — direkter Schreibpfad auf budget_ledger:\n" +
          formatViolations(v) +
          "\n\nbudget_ledger ist GoBD-immutable. Korrekturen MÜSSEN als neue " +
          "Gegenbuchung (Storno-Insert via reservation-storage) erfolgen, nie als " +
          "UPDATE/DELETE bestehender Zeilen.",
      );
    }
  });

  it("Negativ: erkennt bewusst eingebaute Schreibpfade (Drizzle + rohes SQL)", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/fake-update.ts",
        content: `await db.update(budgetLedger).set({ serviceCostCents: 0 }).where(eq(budgetLedger.id, 1));`,
      },
      {
        rel: "server/storage/budget/fake-delete.ts",
        content: `await db.delete(budgetLedger).where(eq(budgetLedger.id, 1));`,
      },
      {
        rel: "server/scripts/fake-raw-sql.ts",
        content: "await db.execute(sql`DELETE FROM budget_ledger WHERE id = 1`);",
      },
      {
        rel: "server/scripts/fake-raw-quoted.ts",
        content: 'await db.execute(sql`UPDATE "budget_ledger" SET service_cost_cents = 0`);',
      },
      {
        rel: "server/scripts/fake-raw-qualified.ts",
        content: "await db.execute(sql`DELETE FROM public.budget_ledger WHERE id = 2`);",
      },
    ];
    const v = detectLedgerWritePathViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/scripts/fake-raw-qualified.ts",
      "server/scripts/fake-raw-quoted.ts",
      "server/scripts/fake-raw-sql.ts",
      "server/storage/budget/fake-delete.ts",
      "server/storage/budget/fake-update.ts",
    ]);
  });

  it("Negativ: matcht NICHT eine ähnlich benannte Tabelle (budget_ledger_archive)", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/scripts/fake-similar-table.ts",
        content: "await db.execute(sql`DELETE FROM budget_ledger_archive WHERE id = 1`);",
      },
    ];
    expect(detectLedgerWritePathViolations(synthetic)).toEqual([]);
  });
});
