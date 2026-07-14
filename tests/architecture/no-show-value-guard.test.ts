/**
 * Task #1762 — Architektur-Test: Leerfahrt-Anzeigen (noShowWaitMinutes /
 * noShowKilometers bzw. die daraus abgeleitete `computeNoShowWage`-Ausgabe)
 * MÜSSEN auf jeder Client-Render-Oberfläche mit einem stabilen
 * `data-testid`-Guard umschlossen sein.
 *
 * Hintergrund: Der „zeigt still 0 / 0,00"-Bug bei Leerfahrt-Werten ist drei
 * Mal in Folge reaktiv aufgetreten — Termin-Detailkachel (#1759),
 * Zeiterfassungs-Tagesdetail (#1760) und Leistungsnachweis-Übersicht
 * (#1761). Jede dieser Oberflächen wurde einzeln nachgerüstet mit einem
 * Guard-`data-testid` (z.B. `text-no-show-km-…`, `text-no-show-wait-minutes-…`),
 * über den ein Round-Trip-Test prüfen kann, dass der Wert nach dem Speichern
 * tatsächlich persistiert wurde und nicht still auf 0 zurückfällt.
 *
 * Ohne strukturelle Schranke könnte eine VIERTE Oberfläche denselben Fehler
 * unbemerkt wieder einführen. Analog zu `km-display-via-helper.test.ts`
 * zieht dieser Test eine Allowlist-Schranke: Jede Client-Datei, die einen
 * Leerfahrt-Wert liest (`computeNoShowWage`, `noShowKilometers`,
 * `noShowWaitMinutes` oder ein `NoShow`-Objekt mit `.kilometers`/
 * `.waitMinutes`), MUSS Guard-`data-testid`s enthalten, die den Substring
 * `no-show-km` UND `no-show-wait-minutes` tragen — sonst schlägt der Test
 * fehl.
 *
 * Failure-Modus: Test listet die Datei und die fehlenden Guards und erklärt
 * das Round-Trip-Muster bzw. wann ein Allowlist-Eintrag (reine Eingabe-/
 * Schreib-Oberfläche, Typ-/Hook-Datei ohne Anzeige) legitim ist.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

/**
 * Signale, dass eine Datei einen Leerfahrt-Wert LIEST, um ihn (potenziell)
 * anzuzeigen. `computeNoShowWage` ist die SSoT für die abgeleitete
 * Fahrtzeit/Wartezeit/km-Ausgabe; die rohen Feldnamen decken direkte
 * Zugriffe ab; der `NoShow`-Objekt-Zweig deckt server-abgeleitete
 * Anzeige-Typen (z.B. `NoShowInfo` in der Leistungsnachweis-Übersicht) ab.
 */
function isNoShowValueCandidate(content: string): boolean {
  if (/computeNoShowWage/.test(content)) return true;
  if (/\bnoShowKilometers\b/.test(content)) return true;
  if (/\bnoShowWaitMinutes\b/.test(content)) return true;
  if (/NoShow/.test(content) && /\.kilometers\b/.test(content) && /\.waitMinutes\b/.test(content)) {
    return true;
  }
  return false;
}

const KM_GUARD_PATTERN = /data-testid=[^>]*?no-show[\w-]*-km/;
const WAIT_GUARD_PATTERN = /data-testid=[^>]*?no-show[\w-]*-wait-minutes/;

/**
 * Pfade, in denen ein Leerfahrt-Wert gelesen wird, OHNE ihn als persistierte
 * Anzeige darzustellen (reine Eingabe-/Schreib-Oberflächen oder Typ-/Hook-
 * Dateien). Diese brauchen keinen Anzeige-Guard.
 */
const ALLOWED_PATHS = [
  // Reines Eingabe-/Dokumentations-Formular: schreibt noShowWaitMinutes/
  // noShowKilometers beim Dokumentieren, zeigt aber keinen persistierten
  // Leerfahrt-Wert als Round-Trip-Anzeige.
  "client/src/pages/document-appointment-no-show.tsx",
];

function isAllowed(relPath: string): boolean {
  return ALLOWED_PATHS.some((p) => relPath === p || relPath.startsWith(p));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/**
 * Strippt Zeilen- und Block-Kommentare, damit Beispiele/Erklärungen in
 * Kommentaren keine falschen Kandidaten oder falschen Guard-Treffer
 * erzeugen.
 */
function stripComments(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (let line of lines) {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) { out.push(""); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd === -1) { line = line.slice(0, blockStart); inBlock = true; }
      else { line = line.slice(0, blockStart) + line.slice(blockEnd + 2); }
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out.join("\n");
}

describe("Architektur — Leerfahrt-Anzeigen brauchen Guard-data-testid", () => {
  it("Jede Client-Render-Oberfläche für noShow-Werte hat km- UND Wartezeit-Guard", () => {
    const root = join(ROOT, "client/src");
    try { statSync(root); } catch { return; }

    const violations: Array<{ file: string; missing: string[] }> = [];

    for (const file of walk(root)) {
      const relPath = relative(ROOT, file).split(sep).join("/");
      if (isAllowed(relPath)) continue;
      const stripped = stripComments(readFileSync(file, "utf-8"));
      if (!isNoShowValueCandidate(stripped)) continue;

      const missing: string[] = [];
      if (!KM_GUARD_PATTERN.test(stripped)) missing.push("no-show-km");
      if (!WAIT_GUARD_PATTERN.test(stripped)) missing.push("no-show-wait-minutes");
      if (missing.length > 0) violations.push({ file: relPath, missing });
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file} — fehlender Guard-data-testid: ${v.missing.join(", ")}`)
        .join("\n");
      expect.fail(
        `Folgende Client-Oberflächen zeigen Leerfahrt-Werte ` +
        `(noShowKilometers/noShowWaitMinutes bzw. computeNoShowWage-Ausgabe) ` +
        `ohne stabilen Guard-data-testid an:\n${msg}\n\n` +
        `Fix: Umschließe die angezeigten Werte mit einem data-testid, dessen ` +
        `Name den Substring 'no-show-km' bzw. 'no-show-wait-minutes' enthält ` +
        `(vgl. #1759/#1760/#1761), sodass ein Round-Trip-Test prüfen kann, ` +
        `dass der Wert nach dem Speichern nicht still auf 0 / 0,00 zurückfällt.\n` +
        `Wenn die Datei den Wert nur schreibt/eingibt oder gar nicht anzeigt ` +
        `(reines Formular, Typ-/Hook-Datei), ergänze sie mit kurzer ` +
        `Begründung in 'ALLOWED_PATHS' in ` +
        `'tests/architecture/no-show-value-guard.test.ts'.`,
      );
    }

    // Sicherstellen, dass der Test tatsächlich greift (keine 0-Kandidaten-
    // Fehlkonfiguration): die drei bekannten Anzeige-Oberflächen müssen als
    // Kandidaten erkannt und als konform bewertet werden.
    const knownSurfaces = [
      "client/src/pages/service-records.tsx",
      "client/src/features/time-tracking/components/day-detail-panel.tsx",
      "client/src/features/appointments/components/appointment-time-services-card.tsx",
    ];
    for (const surface of knownSurfaces) {
      const stripped = stripComments(readFileSync(join(ROOT, surface), "utf-8"));
      expect(isNoShowValueCandidate(stripped), `${surface} sollte als noShow-Kandidat erkannt werden`).toBe(true);
    }
  });
});
