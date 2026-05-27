/**
 * Task #682 — Architektur-Test: Jeder `useMutation(...)`-Aufruf im Client MUSS
 * entweder einen `onError`-Handler im Options-Objekt haben ODER einen
 * `onError-waived:`-Kommentar in unmittelbarer Nähe (im Block oder direkt
 * darüber), der die Auslassung begründet.
 *
 * Hintergrund: Mutations ohne `onError`-Toast schlucken Server-Fehler still —
 * der Nutzer denkt, sein Klick sei verschluckt. Das verletzt die
 * „spezifische deutsche Fehlermeldung"-Konvention aus dem
 * `error-handling-audit`-Skill (siehe replit.md → Pointers).
 *
 * Heuristik:
 *  - Suche `useMutation` (optionaler Type-Param `<...>`) gefolgt von `(`.
 *  - Klammere das gesamte Argument bis zur balancierten schließenden Klammer
 *    nur über `(`/`)`-Zählung — andere Klammern (`{`, `<`, `[`) werden nicht
 *    mitgezählt (TS-Generics verhalten sich sonst nicht-balancierend).
 *  - Innerhalb des Arguments oder in den 6 Zeilen direkt davor MUSS entweder
 *    `onError:` oder ein `onError-waived:`-Kommentar auftauchen.
 *
 * False-Positive-Schutz: Builder-Pattern `useMutation(buildOptions(...))`
 * gilt als ok, wenn die Aufruf-Stelle einen `onError-waived:`-Kommentar trägt
 * und der Builder selbst (anderswo im selben File) ein `onError:` definiert.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const CLIENT_SRC = join(process.cwd(), "client", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function findMutationsWithoutErrorHandling(content: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const regex = /useMutation\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    // Find balanced closing ) using only ( and ) counting.
    let i = m.index + m[0].length - 1; // points at the (
    let depth = 0;
    for (; i < content.length; i++) {
      const c = content[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const blockStart = m.index + m[0].length;
    const block = content.slice(blockStart, i);

    // Search a small window above the call for a waiver comment.
    const linesBefore = content.slice(0, m.index).split("\n");
    const windowBefore = linesBefore.slice(Math.max(0, linesBefore.length - 12)).join("\n");

    const hasOnError = /\bonError\s*:/.test(block);
    const hasWaiver = /onError-waived:/.test(block) || /onError-waived:/.test(windowBefore);

    if (!hasOnError && !hasWaiver) {
      const lineNum = linesBefore.length;
      const snippet = block.split("\n").slice(0, 2).join(" | ").slice(0, 200);
      violations.push({ file, line: lineNum, snippet });
    }
  }
  return violations;
}

describe("Architektur: useMutation muss onError oder Waiver-Kommentar haben", () => {
  it("kein useMutation-Aufruf im Client schluckt Fehler stumm", () => {
    const files = walk(CLIENT_SRC).filter(
      (f) => !f.includes("__tests__") && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    );
    const allViolations: Violation[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (!content.includes("useMutation")) continue;
      allViolations.push(...findMutationsWithoutErrorHandling(content, f));
    }

    if (allViolations.length > 0) {
      const msg = allViolations
        .map(
          (v) =>
            `  - ${v.file.replace(process.cwd() + "/", "")}:${v.line}\n      ${v.snippet}`,
        )
        .join("\n");
      throw new Error(
        `${allViolations.length} useMutation-Aufrufe ohne onError-Handler oder onError-waived:-Kommentar gefunden:\n${msg}\n\n` +
          `Fix: Entweder onError-Handler mit Toast hinzufügen ODER, wenn Auslassung bewusst ist (z.B. Builder-Pattern, separater Fehler-Banner), einen Kommentar "// onError-waived: <Begründung>" im Block oder direkt darüber platzieren.`,
      );
    }

    expect(allViolations).toEqual([]);
  });
});
