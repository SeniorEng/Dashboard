/**
 * Task #1238 (Phase 0.2) / Task #1274 (Stufe C — Retarget) — Append-only-Wächter
 * für `budget_transactions`.
 *
 * Ursprünglich bewachte dieser Wächter den `budget_ledger`-Spiegel; seit dessen
 * finaler Entfernung (Stufe C, Task #1274) ist `budget_transactions` die EINE
 * append-only Finanz-Schicht. Sie ist GoBD-immutable: Korrekturen erfolgen
 * ausschließlich über eine NEUE Gegenbuchung (Storno-Insert), niemals durch
 * stilles Mutieren/Löschen bestehender Zeilen.
 *
 * Die DB erzwingt das über BEFORE-Trigger (siehe
 * `server/startup/ensure-budget-transactions-immutability.ts`); ein legitimer
 * Korrektur-/Cleanup-Pfad MUSS den Bypass-GUC `app.allow_gobd_mutation`
 * explizit setzen. Dieser statische Wächter spiegelt genau diese Regel:
 * ein direkter `db.update/delete(budgetTransactions)` bzw. rohes
 * `UPDATE/DELETE budget_transactions` ist NUR erlaubt, wenn dieselbe Datei den
 * Bypass-GUC setzt (= bewusster, audit-pflichtiger Korrekturpfad). Fehlt der
 * Bypass, ist es ein stiller Schreibpfad und damit eine Append-only-Verletzung.
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
 * Erlaubte Ausnahmen (repo-relativer Pfad). Bewusst LEER: jeder legitime
 * UPDATE/DELETE-Pfad weist sich über den Bypass-GUC aus (siehe Detektor),
 * eine pauschale Datei-Ausnahme ist daher nicht nötig.
 */
const WHITELIST = new Set<string>([]);

/** Drizzle-Schreibpfad: `db.update(budgetTransactions)` / `db.delete(budgetTransactions)`. */
const DRIZZLE_WRITE_RE = /\.(?:update|delete)\s*\(\s*budgetTransactions\b/;

/**
 * Rohes SQL: `UPDATE budget_transactions …` / `DELETE FROM budget_transactions …`.
 * Erfasst auch zitierte (`"budget_transactions"`) und schema-qualifizierte
 * (`public.budget_transactions`) Schreibweisen, damit der Append-only-Schutz
 * nicht trivial umgangen werden kann. Der `\b` direkt hinter
 * `budget_transactions` hält die Regel präzise (matcht NICHT
 * `budget_transactions_archive` o. ä.).
 */
const RAW_SQL_WRITE_RE = /\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?"?budget_transactions\b/i;

/** Bewusster, audit-pflichtiger GoBD-Korrekturpfad: setzt den Bypass-GUC. */
const GOBD_BYPASS_RE = /app\.allow_gobd_mutation/;

export function detectBudgetTransactionsWritePathViolations(
  files: ScanFile[],
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (WHITELIST.has(rel)) continue;
    const code = stripComments(content);
    // Ein Schreibpfad MIT explizitem GoBD-Bypass ist der legitime
    // Korrektur-/Cleanup-Pfad (Audit-pflichtig) — keine Verletzung.
    if (GOBD_BYPASS_RE.test(code)) continue;
    if (DRIZZLE_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "ruft `db.update/delete(budgetTransactions)` OHNE GoBD-Bypass auf — budget_transactions ist append-only (Storno = neue Gegenbuchung)",
      });
    }
    if (RAW_SQL_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "enthält rohes `UPDATE/DELETE budget_transactions` OHNE GoBD-Bypass — budget_transactions ist append-only (Storno = neue Gegenbuchung)",
      });
    }
  }
  return out;
}

describe("Architektur — budget_transactions Append-only-Wächter (Task #1274)", () => {
  it("kein stiller (un-bypasster) UPDATE/DELETE-Schreibpfad auf budget_transactions", () => {
    const files = collectScanFiles(["server", "shared"]);
    const v = detectBudgetTransactionsWritePathViolations(files);
    if (v.length > 0) {
      expect.fail(
        "Append-only-Invariante verletzt — stiller Schreibpfad auf budget_transactions:\n" +
          formatViolations(v) +
          "\n\nbudget_transactions ist GoBD-immutable. Korrekturen MÜSSEN als neue " +
          "Gegenbuchung (Storno-Insert via reservation-storage/consumption-engine) " +
          "erfolgen. Ein bewusster Korrektur-/Cleanup-Pfad MUSS den Bypass-GUC " +
          "`app.allow_gobd_mutation` setzen (audit-pflichtig).",
      );
    }
  });

  it("Negativ: erkennt stille Schreibpfade ohne Bypass (Drizzle + rohes SQL)", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/fake-update.ts",
        content: `await db.update(budgetTransactions).set({ serviceCostCents: 0 }).where(eq(budgetTransactions.id, 1));`,
      },
      {
        rel: "server/storage/budget/fake-delete.ts",
        content: `await db.delete(budgetTransactions).where(eq(budgetTransactions.id, 1));`,
      },
      {
        rel: "server/scripts/fake-raw-sql.ts",
        content: "await db.execute(sql`DELETE FROM budget_transactions WHERE id = 1`);",
      },
      {
        rel: "server/scripts/fake-raw-quoted.ts",
        content: 'await db.execute(sql`UPDATE "budget_transactions" SET service_cost_cents = 0`);',
      },
      {
        rel: "server/scripts/fake-raw-qualified.ts",
        content: "await db.execute(sql`DELETE FROM public.budget_transactions WHERE id = 2`);",
      },
    ];
    const v = detectBudgetTransactionsWritePathViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/scripts/fake-raw-qualified.ts",
      "server/scripts/fake-raw-quoted.ts",
      "server/scripts/fake-raw-sql.ts",
      "server/storage/budget/fake-delete.ts",
      "server/storage/budget/fake-update.ts",
    ]);
  });

  it("Negativ: ein UPDATE/DELETE MIT GoBD-Bypass ist der legitime Korrekturpfad", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/services/legit-correction-drizzle.ts",
        content:
          "await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);\n" +
          "await tx.update(budgetTransactions).set({ appointmentId: null }).where(eq(budgetTransactions.id, 1));",
      },
      {
        rel: "server/scripts/legit-correction-raw.ts",
        content:
          "await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);\n" +
          "await tx.execute(sql`DELETE FROM budget_transactions WHERE customer_id = 1`);",
      },
    ];
    expect(detectBudgetTransactionsWritePathViolations(synthetic)).toEqual([]);
  });

  it("Negativ: matcht NICHT eine ähnlich benannte Tabelle (budget_transactions_archive)", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/scripts/fake-similar-table.ts",
        content: "await db.execute(sql`DELETE FROM budget_transactions_archive WHERE id = 1`);",
      },
    ];
    expect(detectBudgetTransactionsWritePathViolations(synthetic)).toEqual([]);
  });
});
