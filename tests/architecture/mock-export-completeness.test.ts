/**
 * Task #1309 — Architektur-Test: `vi.mock(...)` kritischer Helper-Module darf
 * NICHT aus dem Tritt mit den echten Exports geraten.
 *
 * Hintergrund: `server/services/invoice-pdf-orchestrator.ts` begann
 * `isObjectStorageConfigured()` aus `server/lib/object-storage-helpers` zu
 * nutzen. Die partielle `vi.mock(...)`-Factory in
 * `tests/billing/persist-invoice-pdf-mutex.test.ts` exportierte diese Funktion
 * aber nicht — Vitest warf zur Laufzeit *"No 'isObjectStorageConfigured'
 * export is defined on the mock"* und 3 Tests fielen aus. Der Fix war reaktiv
 * (die fehlende Zeile wurde ergänzt).
 *
 * Diese Fitness-Function macht diese ganze Fehlerklasse unmergebar: Bekommt ein
 * gelistetes „muss-vollständig-bleiben"-Helper-Modul einen neuen Export, MUSS
 * jede partielle `vi.mock(...)`-Factory dieses Moduls entweder den neuen Export
 * mit-stubben ODER über das `importOriginal`-Spread-Muster
 * (`...(await importOriginal())`) automatisch vollständig sein.
 *
 * Was geprüft wird (nur für die `GUARDED_MODULES`-Allowlist):
 *  - Pro Test-Datei werden alle `vi.mock("<modul>", factory)`-Aufrufe via AST
 *    (ast-grep, keine Regex) gefunden, deren Pfad auf ein gelistetes Modul
 *    auflöst.
 *  - Aus der Factory werden die zurückgegebenen Objekt-Keys statisch extrahiert.
 *  - Diese Keys MÜSSEN eine Obermenge der echten Funktions-Exports des Moduls
 *    sein.
 *  - Ausnahmen (automatisch erfüllt):
 *      • `vi.mock("<modul>")` ohne Factory → Vitest auto-mockt alle Exports.
 *      • Factory mit `importOriginal`-Spread (`...(await importOriginal())`)
 *        im Rückgabe-Objekt → erbt alle echten Exports.
 *
 * Erweitern: einen Eintrag in `GUARDED_MODULES` ergänzen (repo-relativer Pfad
 * ohne Endung + kurzer Begründungs-Kommentar). Siehe `tests/architecture/README.md`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname, resolve, relative, sep } from "path";
import { ROOT, walkTsFiles, parseSource } from "./ast-grep-helpers";
import type { SgNode } from "@ast-grep/napi";

/**
 * Helper-Module, deren partielle `vi.mock(...)`-Factories vollständig bleiben
 * MÜSSEN. Bewusst eine kleine, explizite Allowlist — NICHT jeder dünne Mock im
 * Repo soll erschöpfend sein, nur die kritischen SSoT-Helper, deren stille
 * Drift schwer zu debuggende CI-Ausfälle erzeugt.
 *
 * `relPath`: repo-relativer Pfad OHNE Endung (Auflösung erfolgt endungs-agnostisch).
 */
interface GuardedModule {
  relPath: string;
  reason: string;
}

const GUARDED_MODULES: GuardedModule[] = [
  {
    // SSoT für Object-Storage-Pfad-/Konfig-Helper; Render-/Persist-Pfade hängen
    // daran. Ein neuer Export hier (z.B. `isObjectStorageConfigured`) darf eine
    // bestehende partielle Mock-Factory nicht stillschweigend brechen.
    relPath: "server/lib/object-storage-helpers",
    reason:
      "Object-Storage-Pfad-/Konfig-SSoT — Persist-/Render-Pfade importieren daraus.",
  },
];

/** Normalisierter, repo-relativer Pfad mit Forward-Slashes, ohne `.ts`/`.tsx`-Endung. */
function relNoExt(absPath: string): string {
  return relative(ROOT, absPath)
    .split(sep)
    .join("/")
    .replace(/\.tsx?$/, "");
}

/** Liest die echten Laufzeit-Funktions-Exports eines Moduls (typeof === "function"). */
async function realFunctionExports(relPath: string): Promise<string[]> {
  const mod = await import(/* @vite-ignore */ join(ROOT, `${relPath}.ts`));
  return Object.entries(mod)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
    .sort();
}

/** `vi.mock`-Member-Expression? */
function isViMockCall(call: SgNode): boolean {
  const fn = call.field("function");
  if (!fn || fn.kind() !== "member_expression") return false;
  return (
    fn.field("object")?.text() === "vi" &&
    fn.field("property")?.text() === "mock"
  );
}

/** String-Literal-Wert ohne Anführungszeichen (oder null, falls kein Literal). */
function stringLiteralValue(node: SgNode): string | null {
  if (node.kind() !== "string") return null;
  // ast-grep liefert das Literal inkl. Quotes — die ersten/letzten Zeichen weg.
  const raw = node.text();
  return raw.slice(1, -1);
}

/** Das von einer Mock-Factory zurückgegebene Objekt (oder null). */
function getReturnedObject(factory: SgNode): SgNode | null {
  if (factory.kind() !== "arrow_function" && factory.kind() !== "function_expression") {
    return null;
  }
  const body = factory.field("body");
  if (!body) return null;
  if (body.kind() === "object") return body;
  if (body.kind() === "parenthesized_expression") {
    return body.children().find((n) => n.kind() === "object") ?? null;
  }
  if (body.kind() === "statement_block") {
    const ret = body.findAll({ rule: { kind: "return_statement" } })[0];
    if (!ret) return null;
    return ret.children().find((n) => n.kind() === "object") ?? null;
  }
  return null;
}

/** Name des ersten Factory-Parameters (der `importOriginal`-Callback), oder null. */
function firstParamName(factory: SgNode): string | null {
  const params = factory.field("parameters");
  if (!params) return null;
  for (const child of params.children()) {
    if (child.kind() === "identifier") return child.text();
    if (child.kind() === "required_parameter" || child.kind() === "optional_parameter") {
      const pat = child.field("pattern");
      if (pat?.kind() === "identifier") return pat.text();
    }
  }
  return null;
}

/**
 * Verweist der Knoten-Teilbaum auf den Identifier `name`? (z. B. den
 * `importOriginal`-Parameter.) Bewusst über Identifier-Knoten statt über das
 * `function`-Feld eines `call_expression`, weil generische Aufrufe wie
 * `importOriginal<typeof import("…")>()` als `instantiation_expression` geparst
 * werden und das `function`-Feld dann NICHT der nackte Identifier ist.
 */
function referencesIdentifier(node: SgNode, name: string): boolean {
  return node
    .findAll({ rule: { kind: "identifier" } })
    .some((id) => id.text() === name);
}

/**
 * Prüft, ob ein DIREKTES Spread-Element des Rückgabe-Objekts wirklich das
 * Ergebnis von `importOriginal()` einspreizt — entweder direkt
 * (`...(await importOriginal())`) oder indirekt über eine vorher zugewiesene
 * Variable (`const actual = await importOriginal(); return { ...actual }`).
 *
 * Bewusst AST-basiert statt „Spread vorhanden + Text enthält 'importOriginal'":
 * ein unbeteiligtes `...andereObj` zusammen mit einer bloßen Erwähnung von
 * `importOriginal` (Kommentar/String) darf NICHT durchrutschen.
 */
function spreadsImportOriginal(factory: SgNode, obj: SgNode): boolean {
  const paramName = firstParamName(factory);
  if (!paramName) return false;

  const directSpreads = obj.children().filter((c) => c.kind() === "spread_element");
  if (directSpreads.length === 0) return false;

  for (const sp of directSpreads) {
    // Direkt: `...(await importOriginal())` / `...(await importOriginal<…>())`
    if (referencesIdentifier(sp, paramName)) return true;

    // Indirekt: `...actual`, wobei `actual` aus einem `importOriginal()`-Aufruf
    // im Factory-Body stammt.
    const ident = sp.children().find((n) => n.kind() === "identifier");
    if (!ident) continue;
    const varName = ident.text();
    const assignedFromImportOriginal = factory
      .findAll({ rule: { kind: "variable_declarator" } })
      .some((d) => {
        if (d.field("name")?.text() !== varName) return false;
        const value = d.field("value");
        return value ? referencesIdentifier(value, paramName) : false;
      });
    if (assignedFromImportOriginal) return true;
  }
  return false;
}

interface FactoryShape {
  keys: string[];
  /** Rückgabe-Objekt spreizt `importOriginal()` ein (erbt alle echten Exports). */
  hasImportOriginalSpread: boolean;
}

/** Extrahiert die statisch sichtbaren Keys + Spread-Status aus dem Rückgabe-Objekt. */
function analyzeFactory(factory: SgNode): FactoryShape | null {
  const obj = getReturnedObject(factory);
  if (!obj) return null;
  const keys: string[] = [];
  for (const child of obj.children()) {
    const k = child.kind();
    if (k === "pair") {
      const key = child.field("key");
      if (key) keys.push(key.text());
    } else if (k === "shorthand_property_identifier") {
      keys.push(child.text());
    }
  }
  return { keys, hasImportOriginalSpread: spreadsImportOriginal(factory, obj) };
}

interface Violation {
  testFile: string;
  line: number;
  module: string;
  detail: string;
}

describe("Architektur — vi.mock kritischer Helper bleibt vollständig (Task #1309)", () => {
  it("partielle vi.mock-Factories gelisteter Module exportieren alle echten Funktions-Exports", async () => {
    // Echte Funktions-Exports pro gelistetem Modul vorab laden.
    const realExports = new Map<string, string[]>();
    for (const gm of GUARDED_MODULES) {
      realExports.set(gm.relPath, await realFunctionExports(gm.relPath));
    }
    const guardedByRel = new Map(GUARDED_MODULES.map((gm) => [gm.relPath, gm]));

    const violations: Violation[] = [];
    const testsDir = join(ROOT, "tests");

    for (const file of walkTsFiles(testsDir, { includeTsx: true })) {
      const content = readFileSync(file, "utf-8");
      // Schneller Vorab-Filter: Datei nutzt vi.mock überhaupt?
      if (!content.includes("vi.mock")) continue;

      const root = parseSource(content, file.endsWith(".tsx"));
      const testDir = dirname(file);
      const testRel = relative(ROOT, file).split(sep).join("/");

      for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
        if (!isViMockCall(call)) continue;

        const args = call.field("arguments");
        if (!args) continue;
        const argNodes = args
          .children()
          .filter((n) => !["(", ")", ","].includes(n.kind()));
        if (argNodes.length === 0) continue;

        const mockPathRaw = stringLiteralValue(argNodes[0]);
        if (mockPathRaw === null) continue; // dynamischer Pfad — nicht statisch prüfbar

        // Auf ein gelistetes Modul auflösen (endungs-agnostisch). Sowohl relative
        // Spezifizierer (`../../server/lib/...`) als auch repo-root-relative
        // (`server/lib/...`) werden berücksichtigt, damit kein Mock-Stil durch
        // die Maschen fällt.
        const candidates = new Set<string>();
        candidates.add(relNoExt(resolve(testDir, mockPathRaw)));
        if (!mockPathRaw.startsWith(".") && !mockPathRaw.startsWith("/")) {
          candidates.add(mockPathRaw.replace(/\.tsx?$/, "").split(sep).join("/"));
        }
        const gm = [...candidates]
          .map((c) => guardedByRel.get(c))
          .find((x): x is GuardedModule => x !== undefined);
        if (!gm) continue;

        const line = call.range().start.line + 1;
        const required = realExports.get(gm.relPath) ?? [];

        // Ohne Factory: Vitest auto-mockt alle Exports → vollständig.
        if (argNodes.length < 2) continue;

        const factory = argNodes[1];
        const shape = analyzeFactory(factory);

        if (shape === null) {
          violations.push({
            testFile: testRel,
            line,
            module: gm.relPath,
            detail:
              "Mock-Factory-Rückgabe konnte nicht statisch ermittelt werden. " +
              "Gib ein Objekt-Literal zurück oder nutze das `importOriginal`-Spread-Muster " +
              "(`async (importOriginal) => ({ ...(await importOriginal()), /* overrides */ })`).",
          });
          continue;
        }

        // `importOriginal`-Spread erbt alle echten Exports → automatisch vollständig.
        if (shape.hasImportOriginalSpread) continue;

        const missing = required.filter((name) => !shape.keys.includes(name));
        if (missing.length > 0) {
          violations.push({
            testFile: testRel,
            line,
            module: gm.relPath,
            detail: `fehlende Exports: ${missing.join(", ")}`,
          });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(
          (v) =>
            `  ${v.testFile}:${v.line} — vi.mock("${v.module}") → ${v.detail}`,
        )
        .join("\n");
      expect.fail(
        `Partielle vi.mock(...)-Factories gelisteter Helper-Module sind unvollständig:\n` +
          `${msg}\n\n` +
          `Diese Module stehen in GUARDED_MODULES (tests/architecture/mock-export-completeness.test.ts), ` +
          `weil Produktionscode neue Exports bekommen kann, ohne dass ein bestehender Mock mitwächst — ` +
          `Vitest wirft dann zur Laufzeit "No '<name>' export is defined on the mock".\n` +
          `Behebung: entweder die fehlenden Funktionen im Mock mit-stubben, ODER die Factory auf das ` +
          `Spread-Muster umstellen:\n` +
          `  vi.mock("<modul>", async (importOriginal) => ({\n` +
          `    ...(await importOriginal<typeof import("<modul>")>()),\n` +
          `    /* nur die für den Test nötigen Overrides */\n` +
          `  }));`,
      );
    }

    expect(violations).toEqual([]);
  });
});
