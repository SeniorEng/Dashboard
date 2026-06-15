/**
 * Task #1282 (Phase 2 / 2.3) — EIN Schreibpfad für Budget-Type-Settings.
 *
 * Hintergrund: `customer_budget_type_settings` ist die fachliche Quelle für die
 * Frage „welche Töpfe sind für diesen Kunden aktiv?". Sobald mehr als ein Ort
 * direkt in diese Tabelle schreibt, driften Validierung (Selbstzahler-Block,
 * Pflegegrad-Gates, gesetzliche Maxima) und Append-only-/Phasen-Logik. Diese
 * Fitness-Function verankert statisch, dass im Produktions-Request-Pfad NUR die
 * SSoT-Storage-Funktion schreibt:
 *
 *   - `server/storage/budget/preferences-storage.ts`  (SSoT `upsertBudgetTypeSettings`)
 *   - `server/services/customer-deletion-service.ts`  (dokumentierter Soft-Delete-Cascade)
 *
 * Jeder andere direkte Drizzle-Write (`db.insert/update/delete(customerBudgetTypeSettings)`)
 * oder rohes SQL (`INSERT INTO/UPDATE/DELETE FROM customer_budget_type_settings`)
 * im Produktionscode ist eine Verletzung.
 *
 * Ausgeschlossen sind Nicht-Request-Pfade (Tests, Einmal-Skripte, Startup-
 * Migrationen) — sie sind dokumentierte Sonderwerkzeuge und kein Request-Pfad.
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich, dass
 * eine bewusst eingeschleuste Verletzung das (harte, build-brechende) Gate bricht.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

// ---------------------------------------------------------------------------
// Allowlist + Scope
// ---------------------------------------------------------------------------

/**
 * Die EINZIGEN Produktions-Dateien, die direkt in
 * `customer_budget_type_settings` schreiben dürfen.
 */
const WRITE_ALLOWLIST = new Set<string>([
  // SSoT — zentrale Schreib-/Validierungslogik (Selbstzahler-Block, Phasen-Append).
  "server/storage/budget/preferences-storage.ts",
  // Soft-Delete-Cascade beim Kunden-Löschen (GoBD-Historisierung, kein Intent-Write).
  "server/services/customer-deletion-service.ts",
]);

/**
 * Nicht-Request-Pfade: Tests, manuelle Einmal-Skripte und Startup-Migrationen
 * sind dokumentierte Sonderwerkzeuge (kein Produktions-Request-Pfad) und werden
 * vom Scope ausgenommen.
 */
const EXCLUDED_PREFIXES = [
  "tests/",
  "server/scripts/",
  "scripts/",
  "server/startup/",
];

// ---------------------------------------------------------------------------
// Detektor (PUR)
// ---------------------------------------------------------------------------

/**
 * Drizzle-Write auf das Schema-Symbol — `.insert(`/`.update(`/`.delete(`
 * gefolgt vom Tabellen-Symbol `customerBudgetTypeSettings` (Whitespace/Umbruch
 * toleriert).
 */
const DRIZZLE_WRITE_RE =
  /\.(?:insert|update|delete)\s*\(\s*customerBudgetTypeSettings\b/;

/**
 * Rohes SQL — `INSERT INTO` / `UPDATE` / `DELETE FROM` auf den physischen
 * Tabellennamen `customer_budget_type_settings` (case-insensitive).
 */
const RAW_WRITE_RE =
  /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+customer_budget_type_settings\b/i;

export function detectBudgetTypeSettingsWriteViolations(
  files: ScanFile[],
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (WRITE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (DRIZZLE_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "schreibt direkt via Drizzle in `customerBudgetTypeSettings` statt über die SSoT `upsertBudgetTypeSettings`",
      });
    }
    if (RAW_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "schreibt direkt via rohem SQL in `customer_budget_type_settings` statt über die SSoT `upsertBudgetTypeSettings`",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — EIN Budget-Type-Settings-Schreibpfad (Task #1282)", () => {
  const scanFiles = collectScanFiles(["server", "shared"]);

  it("nur die SSoT (+ Soft-Delete-Cascade) schreiben in `customer_budget_type_settings`", () => {
    const v = detectBudgetTypeSettingsWriteViolations(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Budget-Type-Settings-Schreibpfad verletzt — direkter Write außerhalb der SSoT gefunden:\n" +
          formatViolations(v) +
          "\n\n`customer_budget_type_settings` darf im Request-Pfad ausschließlich " +
          "über `upsertBudgetTypeSettings` (server/storage/budget/preferences-storage.ts) " +
          "geschrieben werden — dort liegen Selbstzahler-Block, Pflegegrad-Gates, " +
          "gesetzliche Maxima und die Phasen-Append-Logik. Ist der Write ein " +
          "bewusst neuer, dokumentierter Sonderfall (Soft-Delete/Migration), ergänze " +
          "die Allowlist bzw. EXCLUDED_PREFIXES in " +
          "tests/architecture/budget-typesettings-write-path.test.ts.",
      );
    }
  });

  it("Positiv-Nachweis: die SSoT selbst enthält den erwarteten Drizzle-Write (Detektor greift dort)", () => {
    // Stellt sicher, dass der Detektor nicht versehentlich „nichts findet": die
    // Allowlist-Datei MUSS einen Treffer erzeugen, wenn man sie nicht ausnimmt.
    const ssot = scanFiles.find(
      (f) => f.rel === "server/storage/budget/preferences-storage.ts",
    );
    expect(ssot, "SSoT-Datei muss im Scan enthalten sein").toBeTruthy();
    const v = detectBudgetTypeSettingsWriteViolations([
      { rel: "server/routes/__probe__.ts", content: ssot!.content },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it("Negativ: ein bewusst eingebauter Drizzle-/SQL-Write wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-budget-write.ts",
        content:
          `import { db } from "../lib/db";\n` +
          `import { customerBudgetTypeSettings } from "@shared/schema";\n` +
          `export async function bad() {\n` +
          `  await db.insert(customerBudgetTypeSettings).values({ customerId: 1 });\n` +
          `}\n`,
      },
      {
        rel: "server/routes/fake-budget-raw.ts",
        content:
          "export const q = sql`UPDATE customer_budget_type_settings SET enabled = true WHERE id = 1`;",
      },
    ];
    const v = detectBudgetTypeSettingsWriteViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-budget-raw.ts",
      "server/routes/fake-budget-write.ts",
    ]);
  });

  it("Negativ-Ausnahme: derselbe Write in einem ausgeschlossenen Pfad (Startup/Skript) ist KEINE Verletzung", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/startup/some-migration.ts",
        content:
          "await db.insert(customerBudgetTypeSettings).values({ customerId: 1 });",
      },
      {
        rel: "server/scripts/seed-something.ts",
        content:
          "await db.update(customerBudgetTypeSettings).set({ enabled: false });",
      },
    ];
    expect(detectBudgetTypeSettingsWriteViolations(synthetic)).toEqual([]);
  });

  it("Allowlist: Kommentar-Erwähnungen lösen keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/budget.ts",
        content:
          "// nutzt upsertBudgetTypeSettings; kein direktes db.insert(customerBudgetTypeSettings)\n" +
          "export const x = 1;",
      },
    ];
    expect(detectBudgetTypeSettingsWriteViolations(synthetic)).toEqual([]);
  });
});
