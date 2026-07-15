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

  /**
   * Task #1763 — Der Guard oben stellt nur sicher, dass eine Anzeige-Oberfläche
   * einen stabilen `data-testid` TRÄGT. Er sagt nichts darüber aus, ob dieser
   * Guard auch tatsächlich von einem VERHALTENS-Test (Round-Trip) gelesen wird.
   * Ohne diese zweite Schranke könnte ein Guard-`data-testid` existieren, aber
   * ungetestet sein — die Round-Trip-Abdeckung einer Oberfläche könnte still
   * wegfallen und der „zeigt still 0 / 0,00"-Bug wieder durchrutschen.
   *
   * Diese Schranke prüft daher, dass die Edit-Persistence-Smoke-Suite für jede
   * der drei Anzeige-Oberflächen einen Round-Trip-Test enthält, der
   * (a) eine Leerfahrt dokumentiert (`POST .../document-no-show`),
   * (b) die Seite hart neu lädt (`page.reload(`) und
   * (c) den oberflächenspezifischen Guard-`data-testid` mit dem ECHTEN
   *     Nicht-Null-Wert (Wartezeit + Anfahrt-km) prüft.
   */
  it("Jede noShow-Anzeige-Oberfläche hat einen Verhaltens-Round-Trip, der den Guard liest", () => {
    const specPath = join(ROOT, "e2e/smoke/edit-persistence.spec.ts");
    try { statSync(specPath); } catch {
      expect.fail(
        "e2e/smoke/edit-persistence.spec.ts fehlt — der Verhaltens-" +
        "Round-Trip für Leerfahrt-Werte kann nicht abgesichert werden.",
      );
    }
    const spec = stripComments(readFileSync(specPath, "utf-8"));

    // Grundvoraussetzungen: Leerfahrt-Dokumentation + harter Reload +
    // Nicht-Null-Wert-Assertions müssen mindestens dreimal (je Oberfläche)
    // vorkommen.
    const countOccurrences = (hay: string, needle: string): number =>
      hay.split(needle).length - 1;

    expect(
      countOccurrences(spec, "/document-no-show"),
      "edit-persistence.spec.ts muss die Leerfahrt je Oberfläche dokumentieren " +
        "(POST .../document-no-show) — erwartet ≥ 3 Vorkommen.",
    ).toBeGreaterThanOrEqual(3);

    expect(
      countOccurrences(spec, "page.reload("),
      "edit-persistence.spec.ts muss je Oberfläche hart neu laden " +
        "(page.reload()) — erwartet ≥ 3 Vorkommen.",
    ).toBeGreaterThanOrEqual(3);

    // Jede Oberfläche muss ihren oberflächenspezifischen Guard-data-testid im
    // Spec lesen (km UND Wartezeit). Die Token sind so gewählt, dass sie die
    // drei Oberflächen eindeutig unterscheiden:
    //  - Termin-Detailkachel: statische (un-suffixierte) Guard-ids
    //  - Zeiterfassungs-Tagesdetail: `text-day-no-show-*-<id>`
    //  - Leistungsnachweis-Übersicht: `text-no-show-*-<id>` (suffixiert)
    const behavioralSurfaces: Array<{ surface: string; guardTokens: string[] }> = [
      {
        surface:
          "client/src/features/appointments/components/appointment-time-services-card.tsx",
        guardTokens: [
          "data-testid='text-no-show-km'",
          "data-testid='text-no-show-wait-minutes'",
        ],
      },
      {
        surface:
          "client/src/features/time-tracking/components/day-detail-panel.tsx",
        guardTokens: ["text-day-no-show-km-", "text-day-no-show-wait-minutes-"],
      },
      {
        surface: "client/src/pages/service-records.tsx",
        guardTokens: ["text-no-show-km-", "text-no-show-wait-minutes-"],
      },
    ];

    const missing: string[] = [];
    for (const { surface, guardTokens } of behavioralSurfaces) {
      const absent = guardTokens.filter((t) => !spec.includes(t));
      if (absent.length > 0) {
        missing.push(`  ${surface} — kein Round-Trip liest: ${absent.join(", ")}`);
      }
    }

    if (missing.length > 0) {
      expect.fail(
        "Folgende noShow-Anzeige-Oberflächen haben zwar einen Guard-" +
          "data-testid, werden aber von keinem Verhaltens-Round-Trip-Test in " +
          "e2e/smoke/edit-persistence.spec.ts gelesen:\n" +
          missing.join("\n") +
          "\n\nFix: Ergänze/behalte je Oberfläche einen Round-Trip-Test, der " +
          "eine Leerfahrt dokumentiert, hart neu lädt und den obigen Guard-" +
          "data-testid mit dem ECHTEN Nicht-Null-Wert prüft (vgl. Tests " +
          "#1759/#1760/#1761). Nur einen Guard-data-testid zu setzen genügt " +
          "nicht — der Wert muss nachweislich round-trippen.",
      );
    }
  });
});
