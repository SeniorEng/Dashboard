/**
 * Verriegelt den „stillen Drittel-Skip" des geshardeten Test-Gates.
 *
 * Das Gate läuft als Matrix `tests-shard` mit `--shard=${{ matrix.shard }}/N`.
 * Matrix und Nenner sind zwei getrennte Stellen im YAML, und NICHTS koppelt sie
 * aneinander. Wer die Matrix aus Kostengründen auf `[1, 2]` kürzt und `/3`
 * stehen lässt, überspringt ein Drittel der Testdateien — und **alles bleibt
 * grün**: die Legs, der Aggregator, der Required Check. Auch der
 * Gate-Meta-Check (`scripts/assert-gate-ran.ts`) schlägt nicht an, weil er pro
 * Leg nur „> 0 Tests" prüft, nie eine erwartete Menge.
 *
 * Das ist dieselbe Klasse wie Task #1841 (grünes Gate ohne Tests), eine Ebene
 * höher: grünes Gate mit nur einem Teil der Tests. Die eine Richtung
 * (`--shard=4/3`) bricht laut in Vitest ab; die gefährliche ist still.
 *
 * Geprüft wird deshalb, dass die drei Aussagen zueinander passen:
 *   1. die Matrix-Werte sind lückenlos `1..N` (keine Lücke, kein Duplikat),
 *   2. jede `--shard=…/D`-Stelle trägt denselben Nenner `D`,
 *   3. dieser Nenner `D` ist gleich `N`.
 *
 * Bewusst zeilenbasiert und ohne YAML-Dependency — gleiche Machart wie
 * `gate-meta-check.test.ts`, damit der Wächter selbst keine Angriffsfläche über
 * eine Parser-Version bekommt. Reiner Datei-Read, kein Server/DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const CI_YML = join(process.cwd(), ".github", "workflows", "ci.yml");
const yml = readFileSync(CI_YML, "utf8");
const lines = yml.split(/\r?\n/);

/**
 * Liest die Werte einer `shard: [ … ]`-Matrixzeile. Liefert `null`, wenn es
 * keine gibt — dann ist das Gate nicht geshardet und dieser Wächter schweigt.
 */
function readShardMatrix(): number[] | null {
  const line = lines.find((l) => /^\s*shard:\s*\[/.test(l));
  if (!line) return null;
  const inner = line.slice(line.indexOf("[") + 1, line.lastIndexOf("]"));
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => Number(s));
}

/**
 * Alle Nenner aus `--shard=<irgendwas>/<D>`-Vorkommen im Workflow.
 *
 * Der Index-Teil ist ein GitHub-Ausdruck mit Leerzeichen
 * (`--shard=${{ matrix.shard }}/3`), deshalb `[^\n]*?` statt `\S*?` — sonst
 * findet der Wächter gar nichts und meldet einen Fehler, der keiner ist.
 * Zeilengebunden (kein `s`-Flag), damit ein `/` einer späteren Zeile nicht
 * fälschlich als Trenner gelesen wird.
 */
function readShardDenominators(): number[] {
  const out: number[] = [];
  const re = /--shard=[^\n]*?\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) out.push(Number(m[1]));
  return out;
}

describe("CI-Shard-Partition — Matrix und Nenner dürfen nicht auseinanderlaufen", () => {
  const matrix = readShardMatrix();
  const denominators = readShardDenominators();

  it("wenn geshardet wird, gibt es auch eine Shard-Matrix (und umgekehrt)", () => {
    expect(
      (matrix !== null) === (denominators.length > 0),
      matrix === null
        ? "Es gibt `--shard=…`-Aufrufe, aber keine `shard:`-Matrix — der Nenner hat dann keine Entsprechung."
        : "Es gibt eine `shard:`-Matrix, aber keinen `--shard=…`-Aufruf — die Legs würden alle dieselbe volle Suite fahren.",
    ).toBe(true);
  });

  it.runIf(matrix !== null)("Matrix-Werte sind lückenlos 1..N", () => {
    const sorted = [...matrix!].sort((a, b) => a - b);
    const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
    expect(
      sorted,
      "Die Shard-Indizes müssen lückenlos bei 1 beginnen. Eine Lücke bedeutet: " +
        "die Dateien dieses Index laufen NIE, ohne dass ein Job rot wird.",
    ).toEqual(expected);
  });

  it.runIf(matrix !== null)("alle --shard-Nenner sind identisch", () => {
    expect(
      new Set(denominators).size,
      `Uneinheitliche Nenner (${denominators.join(", ")}) — die Legs würden ` +
        "verschiedene Aufteilungen derselben Dateimenge fahren.",
    ).toBe(1);
  });

  it.runIf(matrix !== null)("der Nenner entspricht der Anzahl der Matrix-Legs", () => {
    expect(
      denominators[0],
      `Matrix hat ${matrix!.length} Legs, --shard nennt aber /${denominators[0]}. ` +
        "Bei Nenner > Legs laufen Dateien NIE (still, alles grün); bei Nenner < Legs " +
        "bricht Vitest laut ab. Beide Zahlen gehören gemeinsam geändert.",
    ).toBe(matrix!.length);
  });
});
