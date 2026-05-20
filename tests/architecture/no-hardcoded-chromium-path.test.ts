/**
 * Task #547 — Architektur-Test: KEINE hartcodierten Chromium-Pfade in `server/`.
 *
 * Hintergrund: Task #544 musste einen hartcodierten Nix-Store-Hash
 * (`/nix/store/<hash>-chromium-…/bin/chromium`) aus `server/services/pdf-generator.ts`
 * entfernen. Der Hash ändert sich bei jedem Rebuild des Deployment-Images und
 * legte dadurch die gesamte PDF-Generierung in Produktion lahm. Damit dieselbe
 * Falle nicht "schnell mal" wieder einzieht, scannt dieser Test den Quellcode
 * unter `server/` nach verdächtigen Mustern und failed mit klarer Meldung.
 *
 * Erlaubt ist ausschließlich Auflösung zur Laufzeit via
 * `server/services/pdf-generator.ts → resolveChromiumPath()`:
 *   1. `CHROMIUM_PATH`-Env
 *   2. `which chromium` / `which chromium-browser`
 *   3. Bekannte System-Fallbacks (`/usr/bin/chromium*`, `/usr/bin/google-chrome*`)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SERVER_DIR = join(process.cwd(), "server");
const ROOT = process.cwd();

const NIX_STORE_CHROMIUM = /\/nix\/store\/[a-z0-9]+[^"'\s]*chromium[^"'\s]*/i;
const EXECUTABLE_PATH_LITERAL =
  /executablePath\s*:\s*["'`]\/(?!\*)[^"'`]*chrom[^"'`]*["'`]/i;

/**
 * Dateien, die diesen Test bewusst nicht greifen sollen.
 * `pdf-generator.ts` selbst enthält die String-Literale `/usr/bin/chromium*`
 * als Fallback-Liste — diese sind erlaubt, weil sie über `existsSync` geprüft
 * werden und keinen Nix-Store-Hash enthalten.
 */
const ALLOWLIST = new Set<string>([
  "server/services/pdf-generator.ts",
]);

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

describe("Architektur: keine hartcodierten Chromium-Pfade in server/ (Task #547)", () => {
  const files = walk(SERVER_DIR);

  it("findet keine /nix/store/<hash>-chromium-Pfade", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      const match = src.match(NIX_STORE_CHROMIUM);
      if (match) {
        offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      "Hartcodierter Nix-Store-Chromium-Pfad gefunden. " +
        "Der Hash ändert sich bei jedem Image-Rebuild und legt die PDF-Engine lahm. " +
        "Stattdessen `resolveChromiumPath()` aus `server/services/pdf-generator.ts` " +
        "verwenden (Env → `which` → /usr/bin-Fallback).",
    ).toEqual([]);
  });

  it("findet keine `executablePath: \"/...chromium...\"`-String-Literale außerhalb der Allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      const match = src.match(EXECUTABLE_PATH_LITERAL);
      if (match) {
        offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      "Direktes `executablePath: \"/...chromium...\"`-Literal gefunden. " +
        "Bitte stattdessen `resolveChromiumPath()` aus `server/services/pdf-generator.ts` " +
        "aufrufen, damit `CHROMIUM_PATH`-Env und PATH-Lookup respektiert werden.",
    ).toEqual([]);
  });
});
