/**
 * Task #1714 — Architektur-Test: `Content-Disposition`-Header müssen den
 * zentralen SSoT `buildContentDisposition` aus
 * `shared/domain/invoice-export-filename.ts` nutzen.
 *
 * Hintergrund: Task #1709 hat die beiden Dokument-Download-Routen auf
 * umlaut-sichere Content-Disposition-Header umgestellt (ASCII-Fallback +
 * RFC-5987-`filename*`). Nichts hindert aber eine NEUE Datei-Download-Route
 * daran, wieder von Hand `inline; filename="${name}"` (ohne `filename*`) zu
 * setzen und damit den „Müller-Vertrag.pdf wird verstümmelt"-Bug auf einer
 * neuen Oberfläche zu reaktivieren.
 *
 * Dieser Test zieht — analog zu `km-display-via-helper.test.ts` — eine
 * strukturelle Schranke: Jede Zuweisung eines `Content-Disposition`-Headers im
 * Server-Code MUSS `buildContentDisposition(...)` im selben Statement
 * aufrufen. Roh gebaute Werte (String-Literale, Template-Strings, eigene
 * `filename=`-Ketten) schlagen fehl mit Datei:Zeile und dem gefundenen
 * Substring.
 *
 * Failure-Modus: Test listet Datei:Zeile und erklärt, wie der Helper
 * einzusetzen ist bzw. wann ein Allowlist-Eintrag legitim wäre.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

/**
 * Pattern: eine Zeile, die den Header-Namen `Content-Disposition` als
 * String-Literal enthält — das deckt `res.setHeader("Content-Disposition", …)`,
 * `res.set("Content-Disposition", …)`, `headers["Content-Disposition"] = …`
 * und Objekt-Literale (`{ "Content-Disposition": … }`) ab. Groß-/
 * Kleinschreibung wird toleriert (HTTP-Header sind case-insensitiv).
 */
const DISPOSITION_HEADER_PATTERN = /["'`]content-disposition["'`]/i;

/**
 * Der einzige erlaubte Weg, einen Content-Disposition-Wert zu bauen.
 */
const HELPER_CALL = "buildContentDisposition";

/**
 * Pfade, in denen ein roher `Content-Disposition`-String legitim ist:
 *  - Der zentrale Helper selbst lebt in `shared/`, nicht in `server/`, und
 *    wird ohnehin nicht gescannt.
 *  - Tests und Skripte.
 */
const ALLOWED_PATHS = [
  "tests/",
  "scripts/",
  "server/scripts/",
  "dist/",
  "node_modules/",
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel === p || rel.startsWith(p));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (entry.endsWith(".d.ts")) continue;
      yield full;
    }
  }
}

/**
 * Strippt Zeilenkommentare (`//...`), damit Header-Namen in Kommentaren
 * (z.B. „… als Content-Disposition setzen") keine falschen Treffer erzeugen.
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

describe("Architektur — Content-Disposition via zentralem Helper", () => {
  it("Kein roher `Content-Disposition`-Header außerhalb der Allowlist", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const scanRoots = ["server"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walk(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i];
          if (inBlockComment) {
            const end = line.indexOf("*/");
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
          }
          const blockStart = line.indexOf("/*");
          if (blockStart !== -1) {
            const blockEnd = line.indexOf("*/", blockStart + 2);
            if (blockEnd === -1) {
              line = line.slice(0, blockStart);
              inBlockComment = true;
            } else {
              line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
            }
          }
          line = stripLineComment(line);
          if (!line) continue;
          if (!DISPOSITION_HEADER_PATTERN.test(line)) continue;

          // Der Wert wird bei mehrzeiligen Aufrufen erst in Folgezeilen
          // übergeben (z.B. `res.setHeader("Content-Disposition",` gefolgt von
          // `buildContentDisposition(` in der nächsten Zeile). Wir prüfen ein
          // kleines Fenster (aktuelle Zeile + bis zu 3 Folgezeilen) auf den
          // Helper-Aufruf.
          const windowText = lines.slice(i, i + 4).join("\n");
          if (windowText.includes(HELPER_CALL)) continue;

          hits.push({
            file: relative(ROOT, file).split(sep).join("/"),
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — '${h.snippet}'`)
        .join("\n");
      expect.fail(
        `Folgende Content-Disposition-Header umgehen den zentralen Helper ` +
        `aus 'shared/domain/invoice-export-filename.ts':\n` +
        `${msg}\n\n` +
        `Fix: Baue den Wert IMMER mit ` +
        `'buildContentDisposition(filename, "inline" | "attachment")'. Der ` +
        `Helper liefert einen ASCII-Fallback UND ein RFC-5987-'filename*', ` +
        `sodass Umlaute (Müller-Vertrag.pdf) im „Speichern unter"-Dialog ` +
        `erhalten bleiben. Ein handgebauter 'inline; filename="\${name}"'-` +
        `Header verstümmelt Umlaute erneut. Wenn der Treffer ein legitimer ` +
        `Sonderfall ist, ergänze die Allowlist 'ALLOWED_PATHS' in ` +
        `'tests/architecture/content-disposition-via-helper.test.ts' mit ` +
        `einer kurzen Begründung.`,
      );
    }
  });
});
