/**
 * Task #776 — Shared helpers for ast-grep-based architectural fitness functions.
 *
 * Hintergrund: Die Fitness-Functions in `tests/architecture/` haben bisher
 * `grep`/Regex zur Code-Inspektion genutzt. Regex matcht aber auch in
 * Kommentaren und String-Literalen, was zu False-Positives führt (z. B.
 * `// function calculateFoo(...)` in einem JSDoc-Block oder
 * `const s = "app.get(...)"` in einer Doku-Konstante).
 *
 * `ast-grep` (`@ast-grep/napi`) parst den TypeScript-AST und matcht nur echte
 * Syntax-Knoten — Kommentare und Strings sind eigene Knotentypen und werden
 * daher korrekt ignoriert. Diese Helper kapseln das Parsen und Datei-Walking,
 * damit die einzelnen Test-Files sich auf ihre jeweilige Regel konzentrieren.
 */
// @ts-nocheck

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { parse, Lang, type SgRoot, type SgNode } from "@ast-grep/napi";

export const ROOT = process.cwd();

/** Parst TS/TSX-Quelltext und liefert den Root-AST-Knoten. */
export function parseSource(code: string, isTsx: boolean): SgNode {
  const root: SgRoot = parse(isTsx ? Lang.Tsx : Lang.TypeScript, code);
  return root.root();
}

/** Rekursiver Walk über `.ts`/`.tsx`-Dateien (ohne `.d.ts`, `node_modules`, `dist`, Dotfiles). */
export function* walkTsFiles(
  dir: string,
  opts: { includeTsx?: boolean } = {},
): Generator<string> {
  const { includeTsx = false } = opts;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkTsFiles(full, opts);
    } else if (entry.endsWith(".d.ts")) {
      continue;
    } else if (entry.endsWith(".ts") || (includeTsx && entry.endsWith(".tsx"))) {
      yield full;
    }
  }
}

/** Normalisierter, repo-relativer Pfad mit Forward-Slashes. */
export function relPath(absPath: string): string {
  return relative(ROOT, absPath).split(sep).join("/");
}

/**
 * Eine DEKLARIERTE, benannte Funktion (oder funktions-wertige Konstante /
 * Klassen-Methode / Objekt-Methode). Aufrufstellen und reine Wert-Variablen
 * (`const x = computeCap(...)`) sind absichtlich NICHT enthalten — nur echte
 * Funktions-Definitionen.
 */
export interface NamedFunction {
  name: string;
  /** 1-basierte Zeilennummer der Deklaration. */
  line: number;
}

const FUNCTION_VALUE = {
  any: [{ kind: "arrow_function" }, { kind: "function_expression" }],
} as const;

/**
 * Sammelt alle benannten Funktions-Definitionen aus einem AST:
 *   - `function foo() {}` / `export async function foo() {}`
 *   - Klassen- & Objekt-Methoden `foo() {}`
 *   - Klassen-Arrow-Felder `foo = () => {}`
 *   - funktions-wertige Variablen `const foo = () => {}` / `= function() {}`
 *   - Objekt-Properties mit Funktionswert `{ foo: () => {} }`
 *
 * Bewusst NICHT erfasst (im Gegensatz zur alten Regex):
 *   - Interface-/Typ-Methoden-Signaturen (`method_signature`) — reine Typen.
 *   - Wert-Variablen wie `const x = computeCap(...)` — keine Definition.
 *   - Vorkommen in Kommentaren/Strings — eigene AST-Knotentypen.
 */
export function collectNamedFunctions(root: SgNode): NamedFunction[] {
  const out: NamedFunction[] = [];
  const push = (node: SgNode, nameField: string) => {
    const nameNode = node.field(nameField);
    if (!nameNode) return;
    out.push({ name: nameNode.text(), line: node.range().start.line + 1 });
  };

  for (const n of root.findAll({ rule: { kind: "function_declaration" } })) {
    push(n, "name");
  }
  for (const n of root.findAll({ rule: { kind: "method_definition" } })) {
    push(n, "name");
  }
  for (const n of root.findAll({ rule: { kind: "public_field_definition", has: { field: "value", ...FUNCTION_VALUE } } })) {
    push(n, "name");
  }
  for (const n of root.findAll({ rule: { kind: "variable_declarator", has: { field: "value", ...FUNCTION_VALUE } } })) {
    push(n, "name");
  }
  for (const n of root.findAll({ rule: { kind: "pair", has: { field: "value", ...FUNCTION_VALUE } } })) {
    push(n, "key");
  }

  return out;
}
