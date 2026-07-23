/**
 * Task #1841 — SSoT-AP0: Der Gate-Meta-Check verriegelt den „stillen Skip".
 *
 * `scripts/assert-gate-ran.ts` fängt ab, dass ein Test-Gate im CI grün
 * durchläuft, OHNE Tests ausgeführt zu haben. Damit dieser Schutz selbst nicht
 * still ausgehebelt werden kann, MUSS der zugehörige CI-Step UNBEDINGT laufen —
 * also OHNE `if:`-Guard. Ein `if:` auf diesem Step würde exakt den Failure-Mode
 * wieder öffnen, den der Step schließen soll (ein kaputter/immer-falscher Guard
 * überspringt Tests UND Meta-Check gleichzeitig → falsches Grün).
 *
 * Dieser Test liest `.github/workflows/ci.yml` zeilenbasiert (keine YAML-
 * Dependency) und besteht nur, wenn:
 *   1. genau ein Step das Meta-Check-Skript `scripts/assert-gate-ran.ts` ausführt,
 *   2. dieser Step KEIN `if:` trägt (unbedingt).
 *
 * Reiner Datei-Read, kein Server/DB — läuft im `unit`/`architecture`-Project.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const CI_YML = join(process.cwd(), ".github", "workflows", "ci.yml");
const STEP_INDENT = "      - "; // 6 Spaces: Step-Ebene innerhalb eines Jobs

/**
 * Extrahiert den Zeilenblock des Steps, der `marker` in einer `run:`-Zeile
 * enthält (von seiner `- name:`/`- uses:`-Startzeile bis exkl. zum nächsten
 * Step-Start bzw. Dedent). Liefert `null`, wenn kein solcher Step existiert.
 */
function extractStepBlock(lines: string[], marker: string): string[] | null {
  const runIdx = lines.findIndex(
    (l) => l.trimStart().startsWith("run:") && l.includes(marker),
  );
  if (runIdx === -1) return null;

  // Rückwärts zum Step-Start laufen.
  let start = runIdx;
  while (start >= 0 && !lines[start].startsWith(STEP_INDENT)) start--;
  if (start < 0) return null;

  // Vorwärts bis zum nächsten Step (`      - `) oder bis zu einem echten Dedent
  // auf Job-/Section-Ebene (< 6 Spaces, nicht-leer). 6-Space-Kommentare
  // (`      # …`) und Leerzeilen bleiben bewusst Teil des Step-Blocks — sonst
  // könnte ein eingeschobener Kommentar den Block abschneiden und ein danach
  // folgendes `if:` der `some()`-Prüfung entgehen.
  let end = start + 1;
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (l.startsWith(STEP_INDENT)) break; // nächster Step
    const indent = l.length - l.trimStart().length;
    if (l.trim() !== "" && indent < 6) break; // Dedent auf Job-/Section-Ebene
  }
  return lines.slice(start, end);
}

describe("CI Gate-Meta-Check (Task #1841)", () => {
  const yml = readFileSync(CI_YML, "utf8");
  const lines = yml.split(/\r?\n/);

  it("führt scripts/assert-gate-ran.ts als CI-Step aus", () => {
    const block = extractStepBlock(lines, "scripts/assert-gate-ran.ts");
    expect(block, "Kein CI-Step führt scripts/assert-gate-ran.ts aus").not.toBeNull();
  });

  it("lässt den Meta-Check-Step UNBEDINGT laufen (kein `if:`-Guard)", () => {
    const block = extractStepBlock(lines, "scripts/assert-gate-ran.ts")!;
    const hasIf = block.some((l) => l.trimStart().startsWith("if:"));
    expect(
      hasIf,
      "Der Gate-Meta-Check-Step darf KEIN `if:` tragen — ein Guard würde den " +
        "stillen-Skip-Schutz selbst aushebelbar machen (Task #1841).",
    ).toBe(false);
  });

  it("verweist auf genau einen Meta-Check-Step (kein Duplikat/Drift)", () => {
    const runHits = lines.filter(
      (l) => l.trimStart().startsWith("run:") && l.includes("scripts/assert-gate-ran.ts"),
    );
    expect(runHits.length).toBe(1);
  });
});
