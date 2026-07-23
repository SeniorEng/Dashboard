/**
 * Task #1839 — Topf-Nutzbarkeits-Entscheidung („ist Topf X am Stichtag Y
 * nutzbar?") ist EINE gemeinsame SSoT: `resolvePotEligibilityAt`
 * (`shared/domain/budgets.ts`).
 *
 * Hintergrund (Task #1838): Neu-Buchungs-Cascade
 * (`server/storage/budget/consumption-engine.ts`) UND der (Monats-)Umbuchungs-
 * Pfad (`server/storage/budget/rebook-storage.ts`) leiten die Berechtigung aus
 * DERSELBEN puren Funktion ab — die Existenz-/Fenster-/Aktiviert-Logik
 * (`!enabled`, `asOfDate < validFrom`, `asOfDate > validTo`,
 * „konfiguriert-aber-außerhalb-Fenster") lebt AUSSCHLIESSLICH in der SSoT.
 *
 * Nichts hinderte bisher eine spätere Änderung daran, in NUR EINEM der beiden
 * Pfade wieder ein inline-Fenster-/Aktiviert-Gate einzuführen — genau die
 * Asymmetrie („Buchung vs. Umbuchung"), die #1838 gerade behoben hat.
 *
 * Diese Fitness-Function verankert das STATISCH (analog
 * `budget-typesettings-read-path.test.ts`):
 *
 *   1. Positiv: beide Entscheidungs-Pfade MÜSSEN `resolvePotEligibilityAt`
 *      aufrufen (kein Pfad darf die Regel weglassen/eigenständig ableiten).
 *   2. Negativ: eine inline nachgebaute Topf-Fenster-Prüfung (relationaler
 *      Vergleich gegen `.validFrom` / `.validTo` auf einer Type-Settings-
 *      Config) außerhalb der SSoT bricht das (build-brechende) Gate.
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
// Scope
// ---------------------------------------------------------------------------

/** Die EINE SSoT der Topf-Nutzbarkeits-Regel (darf die Fenster-Logik enthalten). */
const SSOT_MODULE = "shared/domain/budgets.ts";

/**
 * Die beiden wertrelevanten Entscheidungs-Pfade, die die Nutzbarkeit aus der
 * SSoT ableiten MÜSSEN: Neu-Buchungs-Cascade und (Monats-)Umbuchung.
 */
const ELIGIBILITY_DECISION_PATHS = [
  "server/storage/budget/consumption-engine.ts",
  "server/storage/budget/rebook-storage.ts",
];

// ---------------------------------------------------------------------------
// Detektor (PUR)
// ---------------------------------------------------------------------------

/** Aufruf der gemeinsamen SSoT. */
const RESOLVE_ELIGIBILITY_RE = /\bresolvePotEligibilityAt\s*\(/;

/**
 * Inline nachgebautes Topf-Gültigkeitsfenster: ein relationaler Vergleich
 * (`<`, `>`, `<=`, `>=`) unmittelbar an `.validFrom` / `.validTo`. Das ist der
 * distinktive Kern von `resolvePotEligibilityAt` (`asOfDate < cfg.validFrom` /
 * `asOfDate > cfg.validTo`) und ein starkes Signal für eine Neu-Implementierung.
 *
 * BEWUSST NICHT getroffen: Drizzle-Spalten-Referenzen wie
 * `lte(budgetAllocations.validFrom, today)` oder `asc(...validFrom)` (kein
 * relationaler JS-Operator direkt am Feld) — das ist die FIFO-Allocation-
 * Ordnung, keine Type-Settings-Fenster-Prüfung.
 */
const INLINE_WINDOW_GATE_RES = [
  /[<>]=?\s*[\w.]*\.(?:validFrom|validTo)\b/, // date < cfg.validFrom
  /\.(?:validFrom|validTo)\b\s*[<>]=?/, // cfg.validTo > date
];

/**
 * Flaggt inline Topf-Fenster-Gates in den beiden Entscheidungs-Pfaden (Cascade
 * + Umbuchung). Diese Dateien MÜSSEN die Nutzbarkeit ausschließlich aus der
 * SSoT ableiten; sie enthalten selbst KEINE Type-Settings-Fenster-Vergleiche.
 *
 * Scope bewusst auf die zwei Entscheidungs-Pfade begrenzt: der übrige
 * Budget-Baum (z. B. Versions-/Phasen-Verwaltung in `preferences-storage.ts`,
 * §45a-Aktivität in `summary-queries.ts`) nutzt `.validFrom`/`.validTo`
 * legitim für ANDERE fachliche Fragen — das ist keine Topf-Nutzbarkeits-Regel.
 */
export function detectInlinePotWindowGates(files: ScanFile[]): GuardViolation[] {
  const decisionPaths = new Set(ELIGIBILITY_DECISION_PATHS);
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (!decisionPaths.has(rel)) continue; // nur die zwei Entscheidungs-Pfade
    const code = stripComments(content);
    if (INLINE_WINDOW_GATE_RES.some((re) => re.test(code))) {
      out.push({
        file: rel,
        detail:
          "baut ein Topf-Gültigkeitsfenster inline nach (relationaler Vergleich gegen `.validFrom`/`.validTo`) statt die SSoT `resolvePotEligibilityAt` (shared/domain/budgets.ts) zu nutzen",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — Topf-Nutzbarkeit ist EINE SSoT (resolvePotEligibilityAt, #1839)", () => {
  const scanFiles = collectScanFiles(["server", "shared"]);

  it("Cascade UND Umbuchung leiten die Topf-Nutzbarkeit aus `resolvePotEligibilityAt` ab", () => {
    for (const path of ELIGIBILITY_DECISION_PATHS) {
      const f = scanFiles.find((s) => s.rel === path);
      expect(f, `${path} muss im Scan enthalten sein`).toBeTruthy();
      expect(
        RESOLVE_ELIGIBILITY_RE.test(stripComments(f!.content)),
        `${path} MUSS die gemeinsame SSoT \`resolvePotEligibilityAt\` aufrufen ` +
          "statt die Nutzbarkeit (Fenster/Aktiviert/Existenz) eigenständig abzuleiten",
      ).toBe(true);
    }
  });

  it("kein Pfad außerhalb der SSoT baut ein Topf-Fenster-Gate inline nach", () => {
    const v = detectInlinePotWindowGates(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Topf-Nutzbarkeits-SSoT verletzt — inline nachgebautes Fenster-Gate außerhalb `shared/domain/budgets.ts` gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Existenz-/Fenster-/Aktiviert-Logik (ist Topf X am Stichtag Y nutzbar?) " +
          "MUSS ausschliesslich ueber `resolvePotEligibilityAt` (shared/domain/budgets.ts) laufen. " +
          "Ein inline `asOfDate < validFrom`/`asOfDate > validTo`-Gate reintroduziert die " +
          "Buchung-vs-Umbuchung-Asymmetrie (Task #1838).",
      );
    }
  });

  it("Positiv-Nachweis: würde die SSoT-Fenster-Logik in einen Entscheidungs-Pfad kopiert, greift der Detektor", () => {
    const ssot = scanFiles.find((s) => s.rel === SSOT_MODULE);
    expect(ssot, "shared/domain/budgets.ts muss im Scan enthalten sein").toBeTruthy();
    // Der SSoT-Code (mit `asOfDate < cfg.validFrom` etc.) in einem der zwei
    // Entscheidungs-Pfade MUSS Treffer erzeugen — beweist, dass der Detektor
    // genau diese nachgebaute Fenster-Logik fängt.
    const v = detectInlinePotWindowGates([
      { rel: "server/storage/budget/consumption-engine.ts", content: ssot!.content },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it("Negativ: ein inline nachgebautes Fenster-Gate in einem Buchungs-Pfad wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/consumption-engine.ts",
        content: `if (cfg.validFrom && asOfDate < cfg.validFrom) skip();`,
      },
      {
        rel: "server/storage/budget/rebook-storage.ts",
        content: `const expired = asOfDate > row.validTo;`,
      },
    ];
    const v = detectInlinePotWindowGates(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/storage/budget/consumption-engine.ts",
      "server/storage/budget/rebook-storage.ts",
    ]);
  });

  it("Negativ-Ausnahme: derselbe Vergleich außerhalb der zwei Entscheidungs-Pfade ist KEINE Verletzung (legitime Versions-/§45a-Logik)", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/preferences-storage.ts",
        content: `const endsAfterFrom = r.validTo == null || r.validTo >= fromDate;`,
      },
      {
        rel: "server/storage/budget/summary-queries.ts",
        content: `const active = today >= s45a.validFrom && today <= s45a.validTo;`,
      },
    ];
    expect(detectInlinePotWindowGates(synthetic)).toEqual([]);
  });

  it("Positiv: Drizzle-Spalten-Referenzen (FIFO-Ordnung) lösen KEINEN False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/consumption-engine.ts",
        content:
          `where(lte(budgetAllocations.validFrom, today))\n` +
          `orderBy(asc(budgetAllocations.validFrom))`,
      },
    ];
    expect(detectInlinePotWindowGates(synthetic)).toEqual([]);
  });

  it("Positiv: Kommentar-Erwähnungen von validFrom/validTo lösen keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/budget/rebook-storage.ts",
        content:
          `// Nutzbarkeit via resolvePotEligibilityAt (asOfDate < validFrom etc.)\n` +
          `export const x = 1;`,
      },
    ];
    expect(detectInlinePotWindowGates(synthetic)).toEqual([]);
  });
});
