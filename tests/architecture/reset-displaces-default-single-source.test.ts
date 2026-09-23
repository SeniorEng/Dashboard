import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Wächter: wer über `resetDisplacesAllSources` ENTSCHEIDET, muss den
 * gemeinsamen Default lesen.
 *
 * ── Warum es diesen Wächter gibt ────────────────────────────────────────
 * `RESET_DISPLACES_ALL_SOURCES_DEFAULT` ist die EINE Stelle, an der der
 * §45b-Default-Umschwung passiert. Die Zusage im Docblock lautet: „Umschalten
 * heißt: diese Zeile. Nicht neun."
 *
 * **Sie stimmte nicht.** Zwei Entscheidungsstellen hingen weiter an bloßer
 * Truthiness (`opts?.resetDisplacesAllSources ? … : null`) und pinnten damit
 * `false`, egal was die Konstante sagt. Gemessen (Gate 2 zu #180, B1): mit der
 * Konstante auf `true` liefert `readBudget45bFifoBreakdown` ohne Optionen
 * `current_year = −1.048,00 €` — exakt der Fehler, gegen den dieser Mechanismus
 * gebaut ist, zurück beim Flip.
 *
 * Eine Zusage, die im Docblock steht und im Code nicht gilt, ist schlimmer als
 * keine: sie wird als Beleg gelesen. Deshalb hält sie ab jetzt ein Wächter.
 *
 * ── Was geprüft wird ────────────────────────────────────────────────────
 * Jede Stelle außerhalb der SSoT, die auf `resetDisplacesAllSources`
 * VERZWEIGT, muss `?? RESET_DISPLACES_ALL_SOURCES_DEFAULT` daneben haben.
 *
 * Reines DURCHREICHEN (`resetDisplacesAllSources: opts?.resetDisplacesAllSources`)
 * ist erlaubt und ausdrücklich richtig: es gibt `undefined` weiter, und der
 * Empfänger wendet den Default an. Würde hier der Default eingesetzt, stünde
 * die Entscheidung zweimal.
 */

const WURZEL = path.resolve(__dirname, "..", "..");
const SSOT = path.join("server", "storage", "budget", "allocation-window.ts");
const WURZELN = ["server", "shared", "client/src"];

/**
 * Eine Verzweigung: ternär, `&&` oder `||` auf dem Flag.
 *
 * Die erste Fassung fing auch TYPDEKLARATIONEN
 * (`resetDisplacesAllSources?: boolean`), weil `?` dort ebenfalls steht —
 * neun Fehlalarme, kein echter Fund. Das Fragezeichen der optionalen
 * Eigenschaft ist deshalb ausgeschlossen.
 */
const DEKLARATION = /resetDisplacesAllSources\?\s*:/;
const VERZWEIGT = /resetDisplacesAllSources[^\n]*?(\?[^?:]|&&|\|\|)/;
/** Reines Durchreichen als Objekt-Feld. */
const REICHT_DURCH = /resetDisplacesAllSources:\s*[A-Za-z_$][\w$.?]*\s*[,}]/;

function dateien(dir: string): string[] {
  const voll = path.join(WURZEL, dir);
  let eintraege: string[];
  try { eintraege = readdirSync(voll); } catch { return []; }
  return eintraege.flatMap((e) => {
    const p = path.join(dir, e);
    if (statSync(path.join(WURZEL, p)).isDirectory()) {
      return e === "node_modules" ? [] : dateien(p);
    }
    return /\.tsx?$/.test(e) ? [p] : [];
  });
}

function ohneKommentare(quelle: string): string {
  return quelle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Architektur — der Verdrängungs-Default hat EINE Quelle", () => {
  it("RD-1 – jede Verzweigung auf `resetDisplacesAllSources` liest den Default", () => {
    const verstoesse: string[] = [];

    for (const wurzel of WURZELN) {
      for (const datei of dateien(wurzel)) {
        if (datei === SSOT) continue;
        const roh = readFileSync(path.join(WURZEL, datei), "utf8");
        if (!roh.includes("resetDisplacesAllSources")) continue;
        const quelle = ohneKommentare(roh);

        /**
         * Ueber ANWEISUNGEN pruefen, nicht ueber Zeilen.
         *
         * Die erste Fassung ging zeilenweise vor — und der Mutations-Gegencheck
         * hat sie sofort widerlegt: die wiedereingebaute Verletzung lautet
         *
         *     const resetAnchor = opts?.resetDisplacesAllSources
         *       ? await readResetAnchor(...)
         *       : null;
         *
         * Das Flag steht auf Zeile 1, das Fragezeichen auf Zeile 2. Der
         * Waechter blieb gruen — aus einem Formatierungsgrund, nicht weil der
         * Code in Ordnung war. Genau die Form, gegen die es ihn gibt.
         */
        let offset = 0;
        for (const anweisung of quelle.split(";")) {
          const zeile = quelle.slice(0, offset).split("\n").length;
          offset += anweisung.length + 1;
          if (!anweisung.includes("resetDisplacesAllSources")) continue;
          const flach = anweisung.replace(/\s+/g, " ").trim();
          if (DEKLARATION.test(flach)) continue;
          if (!VERZWEIGT.test(flach)) continue;
          if (REICHT_DURCH.test(flach)) continue;
          if (flach.includes("RESET_DISPLACES_ALL_SOURCES_DEFAULT")) continue;
          verstoesse.push(`${datei}:${zeile}  ${flach.slice(0, 100)}`);
        }
      }
    }

    expect(
      verstoesse,
      "Diese Stellen entscheiden über die Verdrängung, ohne den gemeinsamen "
      + "Default zu lesen. Beim Umlegen der Konstante bewegen sie sich NICHT mit — "
      + "gemessen fällt `allocatedCur` dann auf −1.048,00 €.",
    ).toEqual([]);
  });

  it("RD-2 – Selbstprobe: die Erkennung findet eine eingebaute Verletzung", () => {
    // Ohne diese Probe wäre RD-1 auch dann grün, wenn das Muster kaputt ist —
    // die Form von „grün ohne Aussage", die CLAUDE.md als erste nennt.
    const verletzung = "  const a = opts?.resetDisplacesAllSources ? await x() : null;";
    expect(VERZWEIGT.test(verletzung), "die Verzweigungs-Erkennung greift nicht").toBe(true);
    expect(REICHT_DURCH.test(verletzung), "eine Verzweigung wird als Durchreichen gelesen").toBe(false);

    const erlaubt = "    resetDisplacesAllSources: opts?.resetDisplacesAllSources,";
    expect(REICHT_DURCH.test(erlaubt), "reines Durchreichen wird als Verstoß gelesen").toBe(true);

    const deklaration = "  opts?: { resetDisplacesAllSources?: boolean },";
    expect(DEKLARATION.test(deklaration), "eine Typdeklaration wird als Verzweigung gelesen").toBe(true);

    // Der Fall, an dem die erste Fassung gescheitert ist: Umbruch zwischen
    // Flag und Fragezeichen.
    const ueberZweiZeilen = "const a = opts?.resetDisplacesAllSources\n  ? await x()\n  : null";
    const flach = ueberZweiZeilen.replace(/\s+/g, " ").trim();
    expect(VERZWEIGT.test(flach), "eine umgebrochene Verzweigung wird nicht erkannt").toBe(true);

    const mitDefault = "  const v = (opts?.resetDisplacesAllSources ?? RESET_DISPLACES_ALL_SOURCES_DEFAULT)";
    expect(
      VERZWEIGT.test(mitDefault) && mitDefault.includes("RESET_DISPLACES_ALL_SOURCES_DEFAULT"),
      "die erlaubte Form wird nicht erkannt",
    ).toBe(true);
  });
});
