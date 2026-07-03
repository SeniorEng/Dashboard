/**
 * Task #1611 — Architektur-Test: Kein geleakter `global.fetch`-Stub in Tests.
 *
 * Hintergrund: In `tests/billing/qonto-multi-iban-sync.test.ts` ersetzten
 * mehrere describe-Blöcke `global.fetch` per `vi.stubGlobal("fetch", …)` durch
 * einen Qonto-API-Mock, stellten ihn aber NICHT wieder her. Eine spätere Suite,
 * die die echten HTTP-Helfer (`apiPost`/`apiDelete` → `fetch`) nutzt, erbte dann
 * den Mock; das Login lieferte kein `Set-Cookie` und schlug mit dem
 * irreführenden Fehler „CSRF-Token nicht in Cookies gefunden" fehl.
 *
 * Dieser Test scannt alle Test-Dateien: Wer `fetch` per `vi.stubGlobal` ersetzt,
 * MUSS ihn irgendwo in derselben Datei wieder herstellen (`vi.unstubAllGlobals`
 * oder `vi.restoreAllMocks`) — bevorzugt in einem file-weiten `afterEach`, damit
 * keine Suite mehr von der Ausführungsreihenfolge abhängt.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, "tests");

// `vi.stubGlobal("fetch", …)` / `vi.stubGlobal('fetch', …)` — Whitespace/Newlines
// zwischen `stubGlobal(` und dem Argument sind erlaubt.
const STUB_FETCH = /stubGlobal\(\s*["']fetch["']/;
const RESTORE = /unstubAllGlobals\(\)|restoreAllMocks\(\)/;

/**
 * Entfernt Zeilen- und Block-Kommentare, damit ein bloß dokumentierter
 * `vi.stubGlobal("fetch", …)`-Hinweis (z.B. in tests/helpers/letterxpress.ts)
 * den Guard nicht fälschlich auslöst. Simpel gehalten (kein echter Parser):
 * String-Literale mit `//` sind in Tests unkritisch für dieses Muster.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("Architektur: kein geleakter global.fetch-Stub in Tests (Task #1611)", () => {
  const files = walk(TESTS_DIR);

  it("jede Datei, die fetch stubbt, stellt es auch wieder her", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (STUB_FETCH.test(src) && !RESTORE.test(src)) {
        offenders.push(relative(ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(
      offenders,
      "Test-Datei stubbt global.fetch per vi.stubGlobal(fetch, ...), " +
        "stellt es aber nirgends wieder her. Ein geleakter fetch-Mock vergiftet " +
        "jede spaetere Suite, die die echten HTTP-Helfer (apiPost/apiDelete) nutzt - " +
        "das Login schlaegt dann mit dem CSRF-Token-nicht-in-Cookies-Fehler fehl. " +
        "Bitte einen file-weiten afterEach(() => vi.unstubAllGlobals()) ergaenzen.",
    ).toEqual([]);
  });
});
