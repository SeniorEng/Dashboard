/**
 * Phase 3.2 (C-03 Parität) — Budget-Type-Settings-LESEpfad: Buchung/Verfügbarkeit
 * lesen stichtagsbezogen (`forDate`), nicht den jüngsten Intent (`forEdit`).
 *
 * Hintergrund (Befund C-03): `customer_budget_type_settings` ist versioniert.
 * Es gibt zwei fachlich unterschiedliche Lesarten:
 *
 *   - `{ kind: "forDate", asOfDate }` — die zum Stichtag (Termin-/Transaktions-
 *     datum) GÜLTIGE Konfiguration. ZWINGEND für alle wertrelevanten Pfade:
 *     Konsum-Buchung, Verfügbarkeits-/Overview-Reader, Reservierung, Umbuchungs-
 *     AUSFÜHRUNG. Nur so sieht eine Buchung mit `transactionDate` in der
 *     Vergangenheit nicht versehentlich die heutige/zukünftige Konfig.
 *
 *   - `{ kind: "forEdit" }` / `{ kind: "withTransition" }` — der JÜNGSTE Intent
 *     pro Topf (auch wenn er erst morgen wirksam wird). Ausschließlich für
 *     Edit-/Anzeige-Intent: das Settings-Formular und die Operator-Ansicht
 *     „welche Töpfe sind JETZT deaktiviert?" (Rebook-Preview).
 *
 * C-03 verlangt, dass Rebook-Preview und tatsächliche Buchung NICHT auf
 * unterschiedliche Settings-Stände driften können. Das ist konstruktiv gesichert:
 *  - die Umbuchungs-Ausführung (`rebookDisabledBudgetTransactions`) leitet ihre
 *    Arbeit aus DERSELBEN `getRebookPreview`-Funktion ab (gemeinsame Quelle), und
 *  - die eigentliche Re-Buchung läuft über die `forDate`-Cascade.
 *
 * Diese Fitness-Function verankert das STATISCH: ein wertrelevanter Lesepfad,
 * der versehentlich auf „jüngster Intent" umschwenkt, bricht das (build-
 * brechende) Gate. `forEdit`/`withTransition` und die `@deprecated`-Latest-
 * Intent-Wrapper sind auf die wenigen dokumentierten Edit-/Operator-Stellen
 * begrenzt (Allowlist).
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich, dass
 * eine bewusst eingeschleuste Verletzung das Gate bricht.
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
 * Die EINZIGEN Produktions-Dateien, die „jüngster Intent" (`forEdit` /
 * `withTransition` / die `@deprecated`-Latest-Intent-Wrapper) lesen dürfen.
 */
const LATEST_INTENT_ALLOWLIST = new Set<string>([
  // Resolver + Modus-Typdefinition + `@deprecated`-Wrapper (Definitionsort).
  "server/storage/budget/preferences-storage.ts",
  // Storage-Facade — Interface-Deklaration + Verdrahtung der Wrapper.
  "server/storage/budget-storage.ts",
  // Operator-Ansicht „welche Töpfe sind JETZT deaktiviert?" (Rebook-Preview);
  // die Umbuchungs-AUSFÜHRUNG teilt sich diese Funktion → keine Drift.
  "server/storage/budget/rebook-storage.ts",
  // Settings-Edit-/Anzeige-Endpoint (GET type-settings, UI-Übergangs-Banner) —
  // bewusst Latest-Intent; Buchungs-Routen lesen weiterhin `forDate`.
  "server/routes/budget.ts",
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

/** `readBudgetTypeSettings(..., { kind: "forEdit" })` — jüngster Intent. */
const FOR_EDIT_RE = /kind\s*:\s*["']forEdit["']/;

/** `readBudgetTypeSettings(..., { kind: "withTransition" })` — Edit-Snapshot. */
const WITH_TRANSITION_RE = /kind\s*:\s*["']withTransition["']/;

/** Direkter Aufruf der `@deprecated`-Latest-Intent-Wrapper. */
const LATEST_WRAPPER_RE =
  /\bgetLatestBudgetTypeSettings(?:WithTransition)?\s*\(/;

export function detectLatestIntentReadViolations(
  files: ScanFile[],
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (LATEST_INTENT_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (FOR_EDIT_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          'liest Budget-Type-Settings mit `{ kind: "forEdit" }` (jüngster Intent) statt stichtagsbezogen `{ kind: "forDate", asOfDate }`',
      });
    }
    if (WITH_TRANSITION_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          'liest Budget-Type-Settings mit `{ kind: "withTransition" }` (Edit-Snapshot) statt stichtagsbezogen `{ kind: "forDate", asOfDate }`',
      });
    }
    if (LATEST_WRAPPER_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "ruft einen `@deprecated`-Latest-Intent-Wrapper (`getLatestBudgetTypeSettings[WithTransition]`) direkt auf statt `readBudgetTypeSettings({ kind: \"forDate\", asOfDate })`",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — Budget-Type-Settings-Lesepfad: Buchung liest stichtagsbezogen (C-03)", () => {
  const scanFiles = collectScanFiles(["server", "shared"]);

  it("nur Edit-/Operator-Stellen (Allowlist) lesen den jüngsten Intent — wertrelevante Pfade lesen `forDate`", () => {
    const v = detectLatestIntentReadViolations(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Budget-Type-Settings-Lesepfad verletzt — Latest-Intent-Read außerhalb der Edit-/Operator-Allowlist gefunden:\n" +
          formatViolations(v) +
          '\n\nWertrelevante Lesepfade (Konsum-Buchung, Verfügbarkeit/Overview, ' +
          "Reservierung, Umbuchungs-Ausführung) MÜSSEN stichtagsbezogen lesen " +
          '(`readBudgetTypeSettings(c, { kind: "forDate", asOfDate }, tx)`), sonst ' +
          "driften Preview/Buchung auf unterschiedliche Settings-Stände (Befund C-03). " +
          "`forEdit`/`withTransition` und die Latest-Intent-Wrapper sind ausschließlich " +
          "für Edit-/Anzeige-Intent (Settings-Form) bzw. die Rebook-Preview-Operator-" +
          "Ansicht gedacht. Ist der Read ein bewusst neuer, dokumentierter Edit-/" +
          "Operator-Fall, ergänze LATEST_INTENT_ALLOWLIST in " +
          "tests/architecture/budget-typesettings-read-path.test.ts.",
      );
    }
  });

  it("Positiv-Nachweis: die Operator-Ansicht (rebook-storage) enthält den erwarteten Latest-Intent-Read (Detektor greift dort)", () => {
    // Stellt sicher, dass der Detektor nicht versehentlich „nichts findet": die
    // Allowlist-Datei MUSS einen Treffer erzeugen, wenn man sie nicht ausnimmt.
    const rebook = scanFiles.find(
      (f) => f.rel === "server/storage/budget/rebook-storage.ts",
    );
    expect(rebook, "rebook-storage.ts muss im Scan enthalten sein").toBeTruthy();
    const v = detectLatestIntentReadViolations([
      { rel: "server/routes/__probe__.ts", content: rebook!.content },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it("Negativ: ein bewusst auf jüngsten Intent umgeschwenkter Buchungs-Read wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/consumption-engine.ts",
        content:
          `const s = await readBudgetTypeSettings(customerId, { kind: "forEdit" }, tx);\n`,
      },
      {
        rel: "server/storage/budget/unified-reader.ts",
        content:
          `const s = await readBudgetTypeSettings(customerId, { kind: 'withTransition' });\n`,
      },
      {
        rel: "server/storage/budget/summary-queries.ts",
        content: `const s = await getLatestBudgetTypeSettings(customerId);\n`,
      },
    ];
    const v = detectLatestIntentReadViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/storage/budget/consumption-engine.ts",
      "server/storage/budget/summary-queries.ts",
      "server/storage/budget/unified-reader.ts",
    ]);
  });

  it("Negativ-Ausnahme: derselbe Read in einem ausgeschlossenen Pfad (Startup/Skript/Test) ist KEINE Verletzung", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/startup/some-migration.ts",
        content: `const s = await readBudgetTypeSettings(c, { kind: "forEdit" });`,
      },
      {
        rel: "server/scripts/seed-something.ts",
        content: `const s = await getLatestBudgetTypeSettings(c);`,
      },
    ];
    expect(detectLatestIntentReadViolations(synthetic)).toEqual([]);
  });

  it("Positiv: ein wertrelevanter `forDate`-Read löst KEINEN False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/consumption-engine.ts",
        content:
          `const s = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: params.transactionDate }, tx);`,
      },
    ];
    expect(detectLatestIntentReadViolations(synthetic)).toEqual([]);
  });

  it("Allowlist: Kommentar-Erwähnungen von `forEdit` lösen keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/consumption-engine.ts",
        content:
          `// Buchung liest forDate, NICHT { kind: "forEdit" } / getLatestBudgetTypeSettings\n` +
          `export const x = 1;`,
      },
    ];
    expect(detectLatestIntentReadViolations(synthetic)).toEqual([]);
  });
});
