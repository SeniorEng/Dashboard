/**
 * BUG-19 (Facette A) — Architektur-Schranke: `DEFAULT_BUDGET_POT_ORDER` ist
 * modul-privat in `shared/domain/budgets.ts`.
 *
 * Hintergrund: Die Konstante liefert nur den UNGEGATETEN Roh-Default der
 * gesetzlichen Töpfe (§45b an, §45a/§39 aus). Sie sagt NICHTS über den Anspruch
 * eines konkreten Kunden aus — Selbstzahler haben z. B. keinen §45b-Anspruch.
 * Wer den effektiven Default eines Kunden braucht, MUSS den Resolver
 * `effectiveDefaultPots(customer)` nutzen, der den bereits existierenden
 * Selbstzahler-/Anspruchs-Gate (`defaultStatutoryPotEnabled` →
 * `validateSelbstzahlerBudget`) anwendet.
 *
 * Ein direkter Import der Konstante umgeht den Gate (z. B. §45b fälschlich
 * default-aktiv für Selbstzahler). Der eslint-Rule `no-restricted-imports`
 * deckt nur `client/src` + `server/routes`/`storage`/`services` ab (Lint-Globs);
 * diese Fitness-Function ist der echte Cross-Tree-Guard über `server/`,
 * `client/src/` UND `shared/`.
 *
 * Failure-Modus: Test schlägt fehl mit Datei:Zeile jedes Treffers. Wer einen
 * Treffer sieht, hat einen Roh-Import der Konstante (re-)eingeführt — der
 * korrekte Einstieg ist `effectiveDefaultPots(customer)`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { ROOT, walkTsFiles } from "./ast-grep-helpers";

// Einzige Datei, die die Konstante nennen darf — ihre Definition + der Resolver.
const ALLOWED_FILES = new Set<string>([
  "shared/domain/budgets.ts",
]);

// Trifft den Bezeichner als Wort (Import ODER Verwendung). Bewusst eng auf den
// exakten Namen, damit verwandte Bezeichner nicht fälschlich matchen.
const TOKEN_RE = /\bDEFAULT_BUDGET_POT_ORDER\b/;

describe("Architektur — DEFAULT_BUDGET_POT_ORDER ist modul-privat (BUG-19 Facette A)", () => {
  it("Kein Code außerhalb shared/domain/budgets.ts referenziert die Konstante", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root, { includeTsx: true })) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel.startsWith("tests/")) continue;
        if (ALLOWED_FILES.has(rel)) continue;
        const lines = readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (TOKEN_RE.test(lines[i])) {
            hits.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 140) });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — ${h.snippet}`).join("\n");
      expect.fail(
        `Folgende Stellen referenzieren die modul-private Konstante 'DEFAULT_BUDGET_POT_ORDER':\n` +
        `${msg}\n\n` +
        `Die Konstante liefert nur den ungegateten Roh-Default und ist bewusst modul-privat. ` +
        `Nutze stattdessen 'effectiveDefaultPots(customer)' aus '@shared/domain/budgets' — ` +
        `es wendet den Selbstzahler-/Anspruchs-Gate (defaultStatutoryPotEnabled) an.`,
      );
    }
  });
});
