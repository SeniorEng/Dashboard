/**
 * Task #1238 (Phase 0.2 — Architektur-Wächter) — gemeinsame Helfer für die
 * neuen SSoT-/Schema-/Ledger-Fitness-Functions.
 *
 * Diese Helfer sind bewusst PUR: Jeder Detektor arbeitet auf einer Liste von
 * `{ rel, content }`-Einträgen und gibt Verletzungen zurück. Dadurch können
 * der Real-Tree-Scan (echte Dateien) UND die Negativ-Tests (synthetische
 * Strings) DIESELBE Detektor-Funktion aufrufen — der Negativ-Test beweist
 * damit nachweislich, dass eine bewusste Verletzung CI bricht.
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { ROOT, walkTsFiles, relPath } from "./ast-grep-helpers";

/** Eine zu prüfende Quelldatei (repo-relativer Pfad + Inhalt). */
export interface ScanFile {
  rel: string;
  content: string;
}

/** Ein Treffer eines Architektur-Wächters. */
export interface GuardViolation {
  file: string;
  line?: number;
  detail: string;
}

/**
 * Strippt Block- (`/* … *\/`) und Zeilen- (`// …`) Kommentare, damit eine reine
 * Doku-Erwähnung (z. B. `// nutzt computeCapSlot`) kein False-Positive auslöst.
 * Identisches Muster wie in `budget-single-reader.test.ts`.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Sammelt `{ rel, content }` aller `.ts`(/`.tsx`)-Dateien unter den gegebenen
 * Repo-Roots (z. B. `["server", "shared"]`). Nicht existierende Roots werden
 * still übersprungen.
 */
export function collectScanFiles(
  roots: string[],
  opts: { includeTsx?: boolean } = {},
): ScanFile[] {
  const files: ScanFile[] = [];
  for (const r of roots) {
    const abs = join(ROOT, r);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const file of walkTsFiles(abs, { includeTsx: opts.includeTsx ?? false })) {
      files.push({ rel: relPath(file), content: readFileSync(file, "utf-8") });
    }
  }
  return files;
}

/** Formatiert Treffer für die `expect.fail`-Meldung. */
export function formatViolations(violations: GuardViolation[]): string {
  return violations
    .map((h) => `  ${h.file}${h.line ? `:${h.line}` : ""} — ${h.detail}`)
    .join("\n");
}
