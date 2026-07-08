/**
 * Task #1720 — Architektur-Test: Client darf keine Object-Storage-Download-
 * URLs öffnen, die serverseitig KEINE Route haben.
 *
 * Hintergrund: Zwei Screens (proof-review, Qonto advices-tab) hatten
 * Download-Buttons, die auf eine Proxy-URL
 *   `/api/object-storage/download?path=...`
 * zeigten. Diese Route existierte serverseitig NIE — der Download schlug
 * still fehl (Task #1719 fixte beide Call-Sites, indem sie den gespeicherten
 * `/objects/...`-Pfad direkt öffnen).
 *
 * Die EINZIGE gültige Streaming-Route für gespeicherte Objekt-Pfade ist die
 * authentifizierte
 *   GET /objects/:objectPath(*)
 * aus `server/replit_integrations/object_storage/routes.ts`. (Generierte
 * Dokumente haben eigene, echte Routen unter
 * `/api/(admin|customers)/generated-documents/:id/download` — die sind hier
 * nicht betroffen.)
 *
 * Dieser Test zieht eine strukturelle Schranke: Er sucht im Client-Quellcode
 * nach String-Literalen, die auf einen NICHT existierenden Object-Storage-
 * Download-/Proxy-Endpunkt zeigen (z.B. `/api/object-storage/download`,
 * `object-storage/proxy`, `/api/objects/download`). Findet er einen Treffer,
 * schlägt er fehl mit Datei:Zeile und dem gefundenen Substring.
 *
 * Fix bei Fehlschlag: Öffne stattdessen den gespeicherten `/objects/...`-Pfad
 * direkt (dieser wird durch die authentifizierte `GET /objects/:objectPath(*)`
 * -Route bedient), oder — für generierte Dokumente — die vorhandene
 * `/api/.../generated-documents/:id/download`-Route.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

/**
 * Patterns, die auf einen NICHT existierenden Object-Storage-Download-/
 * Proxy-Endpunkt hindeuten. Bewusst breit gefasst, damit auch Varianten
 * ("proxy", "objects/download", "object-download") gefangen werden, aber
 * eng genug, um die legitimen Pfade NICHT zu treffen:
 *   - `/objects/...`                          (echte Streaming-Route)
 *   - `/api/.../generated-documents/:id/download` (echte Doc-Routen)
 */
const DEAD_URL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/api\/object-storage\b/, label: "/api/object-storage/*" },
  { re: /object-storage\/download/, label: "object-storage/download" },
  { re: /object-storage\/proxy/, label: "object-storage/proxy" },
  { re: /\/api\/objects\/download/, label: "/api/objects/download" },
  { re: /\/api\/object\/download/, label: "/api/object/download" },
];

function shouldSkipFile(rel: string): boolean {
  // Der Guard-Test selbst enthält die verbotenen Strings als Literale.
  return rel === "tests/architecture/no-dead-object-download-url.test.ts";
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/** Strippt Zeilenkommentare (`//...`), damit Beispiele in Kommentaren keine
 * falschen Treffer erzeugen. */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

describe("Architektur — keine toten Object-Storage-Download-URLs im Client", () => {
  it("Client öffnet keine Object-Storage-Download-URLs ohne echte Server-Route", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const clientRoot = join(ROOT, "client/src");
    try { statSync(clientRoot); } catch { return; }

    for (const file of walk(clientRoot)) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (shouldSkipFile(rel)) continue;
      const lines = readFileSync(file, "utf-8").split("\n");
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
        for (const { re, label } of DEAD_URL_PATTERNS) {
          if (re.test(line)) {
            hits.push({ file: rel, line: i + 1, snippet: label });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — '${h.snippet}'`)
        .join("\n");
      expect.fail(
        `Folgende Client-Stellen zeigen auf eine NICHT existierende ` +
        `Object-Storage-Download-URL:\n${msg}\n\n` +
        `Diese Proxy-Endpunkte haben serverseitig keine Route und schlagen ` +
        `still fehl. Die EINZIGE gültige Streaming-Route für gespeicherte ` +
        `Objekt-Pfade ist die authentifizierte 'GET /objects/:objectPath(*)'. ` +
        `Fix: Öffne den gespeicherten '/objects/...'-Pfad direkt (z.B. ` +
        `window.open(entity.objectPath)), oder nutze für generierte Dokumente ` +
        `die vorhandene '/api/.../generated-documents/:id/download'-Route.`,
      );
    }
  });
});
