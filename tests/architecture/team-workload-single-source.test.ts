/**
 * Task #1642 — Architektur-Test: die Team-Kapazitäts-/Auslastungs-Rechnung
 * lebt in genau EINER SSoT (`shared/domain/team-workload.ts`,
 * `computeTeamWorkload`).
 *
 * Hintergrund: Früher gab es DREI parallel gepflegte Kapazitäts-Rechner, die
 * bereits gegeneinander abgedriftet waren — server `computeSollIst` (nur Tests),
 * client `deriveSollIst` (Team-Auslastung-Seite) und client
 * `computeWorkloadMetrics` (Benutzerverwaltung). Sie wurden auf die eine SSoT
 * `computeTeamWorkload` konsolidiert; beide Anzeige-Consumer sind seitdem nur
 * noch dünne Adapter (`team-workload-view.ts`, `components/workload-metrics.ts`),
 * die ausschließlich `computeTeamWorkload` aufrufen.
 *
 * Diese Schranke verhindert, dass ein späterer Change still eine ZWEITE,
 * hand-gerechnete Kapazitäts-Berechnung außerhalb der SSoT einführt und die
 * beiden Views wieder auseinanderlaufen ("Eine SSoT pro fachlicher Frage").
 *
 * Was geprüft wird: Es darf keine Funktion geben, deren NAME auf eine der
 * Kapazitäts-/Auslastungs-/Soll-Ist-/Free-Capacity-Kategorien passt und die
 * AUSSERHALB von `shared/domain/team-workload.ts` (bzw. der Allowlist) liegt.
 * Die Erkennung nutzt `ast-grep` (echte Funktions-Knoten, keine Treffer in
 * Kommentaren/Strings), analog zu `calculations-in-shared.test.ts`.
 *
 * Failure-Modus: Test schlägt fehl mit der Liste der Treffer und dem Hinweis,
 * die Berechnung in `shared/domain/team-workload.ts` zu verankern und die Views
 * über `computeTeamWorkload` zu bedienen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  ROOT,
  walkTsFiles,
  parseSource,
  collectNamedFunctions,
} from "./ast-grep-helpers";

// Die kanonische Heimat der Kapazitäts-/Auslastungs-Rechnung.
const CANONICAL = "shared/domain/team-workload.ts";

// Hotspot-Namensmuster: passt der DEKLARIERTE Funktionsname auf eines davon,
// MUSS die Funktion in der kanonischen SSoT wohnen. Bewusst auf die
// Kapazitäts-SEMANTIK gepinnt (Soll/Ist, Auslastung/Kapazität, committed/
// free-capacity, Überlast) — NICHT auf das generische Wort „Workload", damit
// die legitimen Adapter (`computeWorkloadMetrics`, `metricsFromEntry`,
// `selectTeamWorkloadRows`), die nur `computeTeamWorkload` aufrufen, nicht
// fälschlich zünden.
const CAPACITY_NAME_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^(compute|calculate|derive|resolve).*SollIst/i, reason: "Soll/Ist-Kapazität" },
  {
    regex: /^(compute|calculate|derive|resolve).*(Auslastung|Utilization|Capacity|Kapazit)/i,
    reason: "Auslastung/Kapazität",
  },
  {
    regex:
      /^(compute|calculate|derive|resolve).*(Committed(Hours)?|FreieStunden|FreieKunden|FreeHours|FreeClients|FreeCapacity|Ueberlast|Overload)/i,
    reason: "committed-/free-capacity-Mathe",
  },
];

// Pfade, die explizit erlaubt sind: die kanonische SSoT selbst, Tests und
// Build-Artefakte. Die Adapter-Dateien stehen bewusst NICHT hier — ihre
// Funktionsnamen passen ohnehin nicht auf die Muster, und würden sie es tun
// (= wieder hand-gerechnete Kapazitäts-Mathe), soll der Test zuschlagen.
const ALLOWED_PATHS = [CANONICAL, "tests/", "dist/", "node_modules/"];

function relOf(absPath: string): string {
  return relative(ROOT, absPath).split(sep).join("/");
}

function shouldSkip(absPath: string): boolean {
  const rel = relOf(absPath);
  return ALLOWED_PATHS.some((p) => rel.startsWith(p));
}

/**
 * Scannt eine Quelldatei nach benannten Funktionen, deren Name auf ein
 * Kapazitäts-/Auslastungs-Hotspot-Muster passt. Als pure Funktion
 * herausgezogen, damit gepflanzte Verletzungen im Test gegen sie geprüft
 * werden können.
 */
function findCapacityCalcFunctions(
  content: string,
  isTsx: boolean,
): Array<{ line: number; name: string; reason: string }> {
  const fns = collectNamedFunctions(parseSource(content, isTsx));
  const out: Array<{ line: number; name: string; reason: string }> = [];
  for (const fn of fns) {
    for (const { regex, reason } of CAPACITY_NAME_PATTERNS) {
      if (regex.test(fn.name)) {
        out.push({ line: fn.line, name: fn.name, reason });
        break;
      }
    }
  }
  return out;
}

describe("Architektur — Team-Kapazitäts-Rechnung nur in shared/domain/team-workload.ts (Task #1642)", () => {
  it("die kanonische SSoT existiert und exportiert computeTeamWorkload", () => {
    const canonical = readFileSync(join(ROOT, CANONICAL), "utf-8");
    expect(canonical).toMatch(/export function computeTeamWorkload\b/);
  });

  it("keine hand-gerechnete Kapazitäts-/Auslastungs-Berechnung außerhalb der SSoT", () => {
    const hits: Array<{ file: string; line: number; name: string; reason: string }> = [];
    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walkTsFiles(root, { includeTsx: true })) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        for (const h of findCapacityCalcFunctions(content, file.endsWith(".tsx"))) {
          hits.push({ file: relOf(file), ...h });
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — ${h.name} (${h.reason})`)
        .join("\n");
      expect.fail(
        `Folgende Funktionen implementieren Team-Kapazitäts-/Auslastungs-Mathe ` +
          `außerhalb von '${CANONICAL}':\n${msg}\n\n` +
          `Es gibt genau EINE SSoT für die Frage "Wer ist überlastet, wer kann ` +
          `noch Kunden übernehmen?": \`computeTeamWorkload\` in '${CANONICAL}'. ` +
          `Verankere die Berechnung dort und bediene die Views (Team-Auslastung ` +
          `UND Benutzerverwaltung) über diese Funktion — baue keine zweite, ` +
          `hand-gerechnete Kapazitäts-Berechnung, sonst driften die Views wieder ` +
          `auseinander.`,
      );
    }
  });

  describe("Selbsttest der Hotspot-Erkennung (gepflanzte Verletzungen)", () => {
    it("erwischt einen wieder-eingeführten deriveSollIst-Rechner", () => {
      const planted = [
        "export function deriveSollIst(soll: number, ist: number) {",
        "  const free = Math.max(0, soll - ist);",
        "  return { free, pct: (ist / soll) * 100 };",
        "}",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("deriveSollIst");
    });

    it("erwischt einen hand-gerechneten computeAuslastung-Rechner", () => {
      const planted = [
        "export const computeAuslastung = (committed: number, soll: number) => {",
        "  return (committed / soll) * 100;",
        "};",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("computeAuslastung");
    });

    it("erwischt einen computeFreieStunden-Rechner", () => {
      const planted = [
        "function computeFreieStunden(soll: number, used: number) {",
        "  return Math.max(0, soll - used);",
        "}",
      ].join("\n");
      const hits = findCapacityCalcFunctions(planted, false);
      expect(hits.map((h) => h.name)).toContain("computeFreieStunden");
    });

    it("lässt die legitimen Adapter-Namen durch (kein Fehlalarm)", () => {
      // Diese Namen bedienen die SSoT nur — sie rechnen keine Kapazität selbst.
      const legit = [
        "export function computeWorkloadMetrics() { return null; }",
        "export function metricsFromEntry() { return null; }",
        "export function selectTeamWorkloadRows() { return []; }",
        "export function computeTeamWorkload() { return null; }",
        "export function generateReport() { return 0; }",
      ].join("\n");
      expect(findCapacityCalcFunctions(legit, false)).toHaveLength(0);
    });
  });
});
