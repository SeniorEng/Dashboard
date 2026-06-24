/**
 * Task #1289 (Phase 3.1) — EIN Schreibpfad für `budget_allocations`
 * + kein Write von Altlast-Quellen.
 *
 * Hintergrund: `budget_allocations` enthält seit Phase 3.1 ausschließlich
 * MANUELLE Fakten — `initial_balance` (Startwert), `carryover` (Übertrag) und
 * `manual_adjustment` (Korrektur). Die monatliche/jährliche Aufstockung wird
 * rein rechnerisch zur Laufzeit ermittelt (`calculateAllocated45b`/`…45a`/
 * `…39_42a`) und NICHT mehr als Zeile materialisiert. Die früheren Quellen
 * `monthly`/`monthly_auto`/`yearly_auto`/`statutory_monthly` sind aus dem Enum
 * (`BUDGET_ALLOCATION_SOURCES`) entfernt.
 *
 * Sobald mehr als ein Ort direkt in diese Tabelle schreibt, driften die
 * Quellen-Validierung und die Append-only-/Historisierungs-Logik — und ein
 * neuer Writer könnte die Altlast-Aufstockung erneut materialisieren, was sofort
 * wieder einen „Anzeige vs. Buchung"-Drift erzeugt (der Reader summiert die
 * Zeilen NICHT, rechnet aber die virtuelle Aufstockung obendrauf ⇒
 * Doppelzählung).
 *
 * Diese Fitness-Function verankert daher statisch ZWEI Garantien:
 *   1. **Schreibpfad-Vertrag**: Im Produktions-Request-Pfad schreiben NUR die
 *      unten allowgelisteten Dateien direkt in `budget_allocations` (Drizzle
 *      `.insert/.update/.delete(budgetAllocations)` ODER rohes SQL auf
 *      `budget_allocations`). Jeder andere direkte Write ist eine Verletzung —
 *      auch mit erlaubten Quellen (`carryover`/`manual_adjustment`).
 *   2. **Keine Altlast-Quelle** (Sekundär-Check): Kein Produktionscode nennt die
 *      entfernten Quellen-Werte als String-Literal.
 *
 * Scope-Unterschied der beiden Detektoren:
 *   - Detektor 1 (Schreibpfad) schließt Nicht-Request-Pfade pauschal aus (Tests,
 *     Einmal-Skripte, Startup-Migrationen) — dort sind Bulk-Writes auf
 *     `budget_allocations` legitim und breit.
 *   - Detektor 2 (Altlast-Literale) ist ENGER (Task #1416): er scannt auch
 *     `server/startup/` und `server/scripts/` und lässt die entfernten
 *     Quellen-Werte NUR in zwei explizit allowgelisteten Dateien zu — der live
 *     `-1409`-Cleanup-Migration und der Destructive-Migrations-Preflight-Probe.
 *     Jeder andere Treffer (auch in Startup/Skript) ist eine Verletzung.
 *
 * Beide Detektoren sind PUR und werden vom Real-Tree-Scan UND vom Negativ-Test
 * mit DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich,
 * dass eine bewusst eingeschleuste Verletzung das (harte, build-brechende) Gate
 * bricht.
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
 * Die EINZIGEN Produktions-Dateien, die direkt in `budget_allocations`
 * schreiben dürfen.
 */
const WRITE_ALLOWLIST = new Set<string>([
  // SSoT — zentrale Schreib-/Quellen-/Historisierungs-Logik für Allocations.
  "server/storage/budget/allocation-storage.ts",
  // Soft-Delete-Cascade beim Kunden-Löschen (GoBD-Historisierung, kein Intent-Write).
  "server/services/customer-deletion-service.ts",
  // Task #608 — Soft-Delete einer einzelnen Startwert-/Übertrags-Allocation
  // (initial_balance/carryover/manual_adjustment) inkl. Legacy-Feld-Cleanup in
  // einer Transaktion; dokumentierter Admin-Pfad.
  "server/routes/budget.ts",
  // Dokumentiertes Bulk-Purge-Werkzeug (Superadmin-only, in Prod deaktiviert) —
  // räumt Test-/Junk-Daten via rohem SQL ab, kein fachlicher Request-Write.
  "server/services/test-data-cleanup.ts",
]);

/**
 * Schreibpfad-Scope (Detektor 1): Nicht-Request-Pfade — Tests, manuelle
 * Einmal-Skripte und Startup-Migrationen — sind dokumentierte Sonderwerkzeuge
 * (kein Produktions-Request-Pfad) und schreiben `budget_allocations` legitim per
 * Bulk; sie werden vom Schreibpfad-Detektor ausgenommen.
 */
const EXCLUDED_PREFIXES = [
  "tests/",
  "server/scripts/",
  "scripts/",
  "server/startup/",
];

function inScope(rel: string): boolean {
  return !EXCLUDED_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Literal-Scope (Detektor 2, Task #1416): KEIN Blanket-Ausschluss für
 * `server/startup/` oder `server/scripts/` mehr — nur Tests sind außen vor.
 * Die entfernten Altlast-Quellen-Werte dürfen ausschließlich in diesen beiden
 * legitimen Dateien als String-Literal vorkommen:
 *   - die live `-1409`-Cleanup-Migration (löscht die Altlast-Auto-Zeilen),
 *   - die Destructive-Migrations-Preflight-Probe (zählt die offenen Zeilen).
 * Jeder andere Treffer in `server`/`shared` ist eine Verletzung.
 */
const LEGACY_SOURCE_LITERAL_ALLOWLIST = new Set<string>([
  "server/startup/cleanup-legacy-auto-allocations-migration.ts",
  "server/startup/pending-destructive-migrations-preflight.ts",
]);

function inLiteralScope(rel: string): boolean {
  return !rel.startsWith("tests/");
}

// ---------------------------------------------------------------------------
// Detektor 1 (PUR) — Schreibpfad-Vertrag
// ---------------------------------------------------------------------------

/**
 * Drizzle-Write auf das Schema-Symbol — `.insert(`/`.update(`/`.delete(`
 * gefolgt vom Tabellen-Symbol `budgetAllocations` (Whitespace/Umbruch
 * toleriert). Greift unabhängig vom Executor-Namen (`db`/`tx`/`d`/`executor`).
 */
const DRIZZLE_WRITE_RE =
  /\.(?:insert|update|delete)\s*\(\s*budgetAllocations\b/;

/**
 * Rohes SQL — `INSERT INTO` / `UPDATE` / `DELETE FROM` auf den physischen
 * Tabellennamen `budget_allocations` (case-insensitive).
 */
const RAW_WRITE_RE =
  /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+budget_allocations\b/i;

export function detectBudgetAllocationWriteViolations(
  files: ScanFile[],
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (!inScope(rel)) continue;
    if (WRITE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (DRIZZLE_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "schreibt direkt via Drizzle in `budgetAllocations` statt über die SSoT-Allocation-Storage",
      });
    }
    if (RAW_WRITE_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "schreibt direkt via rohem SQL in `budget_allocations` statt über die SSoT-Allocation-Storage",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detektor 2 (PUR) — keine Altlast-Quellen-Literale
// ---------------------------------------------------------------------------

/**
 * Die entfernten Altlast-Quellen als String-Literal (einfache ODER doppelte
 * Anführungszeichen). Kommentare werden vorab gestrippt, damit eine reine
 * Doku-/Historie-Erwähnung kein False-Positive auslöst.
 *
 * Bewusst NICHT enthalten: das Pre-Enum-Literal `monthly`. `"monthly"` ist im
 * Produktionscode ein legitimer, breit genutzter Wert (Service-Record-Typ
 * `recordType: "monthly"`), ein bloßer Literal-Scan darauf würde massenhaft
 * False-Positives erzeugen. Die Re-Einführung von `source: "monthly"` in
 * `budget_allocations` ist trotzdem abgedeckt: jeder Write läuft über die
 * allowgelistete SSoT (Detektor 1), und dort macht das getrimmte Enum
 * `BUDGET_ALLOCATION_SOURCES` den Wert `"monthly"` zum Compile-Fehler.
 */
const LEGACY_SOURCE_LITERAL_RE =
  /(['"])(monthly_auto|yearly_auto|statutory_monthly)\1/;

export function detectLegacyAllocationSourceLiterals(
  files: ScanFile[],
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (!inLiteralScope(rel)) continue;
    if (LEGACY_SOURCE_LITERAL_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    code.split("\n").forEach((line, idx) => {
      const m = line.match(LEGACY_SOURCE_LITERAL_RE);
      if (m) {
        out.push({
          file: rel,
          line: idx + 1,
          detail: `nennt die entfernte Altlast-Allocation-Quelle \`${m[2]}\` als String-Literal`,
        });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — EIN Budget-Allocation-Schreibpfad + keine Altlast-Quellen (Task #1289)", () => {
  const scanFiles = collectScanFiles(["server", "shared"]);

  // -- Detektor 1: Schreibpfad-Vertrag -------------------------------------

  it("nur die allowgelisteten Pfade schreiben direkt in `budget_allocations`", () => {
    const v = detectBudgetAllocationWriteViolations(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Budget-Allocation-Schreibpfad verletzt — direkter Write außerhalb der Allowlist gefunden:\n" +
          formatViolations(v) +
          "\n\n`budget_allocations` darf im Request-Pfad ausschließlich über die " +
          "SSoT-Allocation-Storage (server/storage/budget/allocation-storage.ts) " +
          "geschrieben werden — dort liegen Quellen-Validierung und Historisierung. " +
          "Ist der Write ein bewusst neuer, dokumentierter Sonderfall " +
          "(Soft-Delete-Cascade/Admin-Route/Bulk-Purge/Migration), ergänze die " +
          "Allowlist bzw. EXCLUDED_PREFIXES in " +
          "tests/architecture/budget-allocation-source-write-path.test.ts.",
      );
    }
  });

  it("Positiv-Nachweis: die SSoT selbst enthält den erwarteten Drizzle-Write (Detektor greift dort)", () => {
    const ssot = scanFiles.find(
      (f) => f.rel === "server/storage/budget/allocation-storage.ts",
    );
    expect(ssot, "SSoT-Allocation-Storage muss im Scan enthalten sein").toBeTruthy();
    const v = detectBudgetAllocationWriteViolations([
      { rel: "server/routes/__probe__.ts", content: ssot!.content },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it("Negativ: ein bewusst eingebauter Drizzle-/SQL-Write wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-alloc-write.ts",
        content:
          `import { db } from "../lib/db";\n` +
          `import { budgetAllocations } from "@shared/schema";\n` +
          `export async function bad() {\n` +
          `  await db.insert(budgetAllocations).values({ source: "carryover" });\n` +
          `}\n`,
      },
      {
        rel: "server/services/fake-alloc-raw.ts",
        content:
          "export const q = sql`UPDATE budget_allocations SET deleted_at = now() WHERE id = 1`;",
      },
    ];
    const v = detectBudgetAllocationWriteViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-alloc-write.ts",
      "server/services/fake-alloc-raw.ts",
    ]);
  });

  it("Negativ-Ausnahme: derselbe Write in einem ausgeschlossenen Pfad (Startup/Skript) ist KEINE Verletzung", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/startup/some-migration.ts",
        content: "await db.insert(budgetAllocations).values({ customerId: 1 });",
      },
      {
        rel: "server/scripts/some-budget-cleanup.ts",
        content: "await tx.delete(budgetAllocations).where(inArray(budgetAllocations.id, ids));",
      },
    ];
    expect(detectBudgetAllocationWriteViolations(synthetic)).toEqual([]);
  });

  it("Allowlist: ein erlaubter Writer löst KEINE Verletzung aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/budget.ts",
        content: "await tx.update(budgetAllocations).set({ deletedAt: new Date() });",
      },
    ];
    expect(detectBudgetAllocationWriteViolations(synthetic)).toEqual([]);
  });

  it("Kommentar-Erwähnung eines Writes löst keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/some-route.ts",
        content:
          "// historisch: hier stand mal db.insert(budgetAllocations)\n" +
          "export const x = 1;",
      },
    ];
    expect(detectBudgetAllocationWriteViolations(synthetic)).toEqual([]);
  });

  // -- Detektor 2: keine Altlast-Quellen-Literale --------------------------

  it("kein Produktionscode schreibt `monthly_auto`/`yearly_auto`/`statutory_monthly`", () => {
    const v = detectLegacyAllocationSourceLiterals(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Altlast-Allocation-Quelle im Produktionscode gefunden:\n" +
          formatViolations(v) +
          "\n\n`budget_allocations.source` darf im Request-Pfad ausschließlich " +
          "`initial_balance`/`carryover`/`manual_adjustment` sein. Monatliche/" +
          "jährliche Aufstockung wird rein rechnerisch ermittelt (siehe " +
          "`calculateAllocated45b`/`…45a`/`…39_42a`), nicht materialisiert. " +
          "Die entfernten Quellen-Werte dürfen NUR in den beiden allowgelisteten " +
          "Dateien (live `-1409`-Cleanup-Migration, Destructive-Migrations-" +
          "Preflight-Probe) vorkommen — siehe LEGACY_SOURCE_LITERAL_ALLOWLIST in " +
          "tests/architecture/budget-allocation-source-write-path.test.ts.",
      );
    }
  });

  it("Negativ: ein bewusst eingebautes Altlast-Literal wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-alloc-write.ts",
        content:
          `await db.insert(budgetAllocations).values({ source: "monthly_auto" });\n`,
      },
      {
        rel: "server/storage/budget/fake-statutory.ts",
        content: `const s = 'statutory_monthly';\n`,
      },
    ];
    const v = detectLegacyAllocationSourceLiterals(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-alloc-write.ts",
      "server/storage/budget/fake-statutory.ts",
    ]);
  });

  it("Allowlist: die beiden legitimen Startup-Dateien dürfen die Altlast-Literale nennen", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/startup/cleanup-legacy-auto-allocations-migration.ts",
        content: `const LEGACY_AUTO_SOURCES = ["monthly_auto", "yearly_auto"] as const;`,
      },
      {
        rel: "server/startup/pending-destructive-migrations-preflight.ts",
        content: `inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]);`,
      },
    ];
    expect(detectLegacyAllocationSourceLiterals(synthetic)).toEqual([]);
  });

  it("Verschärfung (Task #1416): ein anderer Startup-/Skript-Pfad mit Altlast-Literal IST jetzt eine Verletzung", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/startup/some-other-migration.ts",
        content: `await db.execute(sql\`UPDATE budget_allocations SET source='monthly_auto'\`);`,
      },
      {
        rel: "server/scripts/some-budget-cleanup.ts",
        content: `const LEGACY = ["monthly_auto", "yearly_auto", "statutory_monthly"];`,
      },
    ];
    const v = detectLegacyAllocationSourceLiterals(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/scripts/some-budget-cleanup.ts",
      "server/startup/some-other-migration.ts",
    ]);
  });

  it("erlaubte Quellen lösen keinen Treffer aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/allocation-storage.ts",
        content:
          `const ok = ["initial_balance", "carryover", "manual_adjustment"];\n` +
          `if (a.source === "carryover") {}\n`,
      },
    ];
    expect(detectLegacyAllocationSourceLiterals(synthetic)).toEqual([]);
  });

  it("Kommentar-Erwähnungen lösen keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "shared/schema/budget.ts",
        content:
          `// Task #1289: Altlast-Quellen monthly_auto/yearly_auto/statutory_monthly entfernt\n` +
          `/* historisch: 'statutory_monthly' war eine materialisierte Zeile */\n` +
          `export const x = 1;`,
      },
    ];
    expect(detectLegacyAllocationSourceLiterals(synthetic)).toEqual([]);
  });
});
