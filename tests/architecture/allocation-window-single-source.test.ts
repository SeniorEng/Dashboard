import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Wächter: das Gültigkeitsfenster einer Budget-Zuweisung wird NICHT
 * handgeschrieben.
 *
 * ── Warum es diesen Wächter gibt (P1 `6hXp9qMrXH2WGVVG`, Punkt 2) ───────
 * Die Frage „zählt diese Zuweisung zum Stichtag?" war an **sechs** Stellen
 * beantwortet — einmal als TS-Closure, fünfmal als handgeschriebenes SQL.
 * Alle fünf SQL-Fassungen bildeten nur das Zeitfenster nach; solange die
 * maßgebliche Fassung auch nur das Zeitfenster war, waren sie deckungsgleich
 * und damit unauffällig.
 *
 * **Genau das ist die gefährliche Lage**, nicht der sichtbare Unterschied:
 * sechs Stellen tun heute zufällig dasselbe, und die nächste Änderung trifft
 * fünf davon. Mit der Reset-Verdrängung wäre `allocatedCur` gemessen auf
 * **−1.048,00 €** gekippt, und der Client filtert den negativen Topf über
 * `p.allocatedCents > 0` still weg — der Fehler wäre nirgends aufgefallen.
 *
 * Der Wächter sucht deshalb nach dem MUSTER, nicht nach den bekannten
 * Fundstellen: `validFrom <= X` zusammen mit `expiresAt >= X` in derselben
 * Bedingung. Wer das neu schreibt, statt `allocationValidAtWhere` zu rufen,
 * fällt auf.
 */

const SSOT = "server/storage/budget/allocation-window.ts";
// Gate 2 zu #166, S7: die erste Fassung scannte drei Wurzeln. `budgetAllocations`
// wird in 18 Dateien ausserhalb davon benutzt — `server/lib`, `server/startup`,
// `server/scripts`, und `server/storage` auf oberster Ebene fiel durch, weil die
// Wurzel `server/storage/budget` hiess.
const WURZELN = ["server/storage", "server/services", "server/routes", "server/lib", "server/startup"];

/** Einzige erlaubte Fundstelle: die SSoT selbst. */
const ERLAUBT = new Set([SSOT]);

function dateienUnter(wurzel: string): string[] {
  const treffer: string[] = [];
  const lauf = (verzeichnis: string) => {
    for (const eintrag of readdirSync(verzeichnis)) {
      const pfad = join(verzeichnis, eintrag);
      if (statSync(pfad).isDirectory()) lauf(pfad);
      else if (pfad.endsWith(".ts") && !pfad.endsWith(".test.ts")) treffer.push(pfad);
    }
  };
  lauf(wurzel);
  return treffer;
}

/**
 * Trägt die Datei ein handgeschriebenes Gültigkeitsfenster auf
 * `budgetAllocations`?
 *
 * Bewusst grob: beide Hälften im selben File genügen. Ein Wächter, der nur
 * die exakte Schreibweise kennt, meldet nichts, sobald jemand umformatiert —
 * und dann ist er schlimmer als keiner, weil er Sicherheit vortäuscht.
 */
function hatHandgeschriebenesFenster(inhalt: string): boolean {
  if (!inhalt.includes("budgetAllocations") && !inhalt.includes("validFrom")) return false;
  // Drizzle-Form.
  const drizzle = /lte\(\s*budgetAllocations\.validFrom/.test(inhalt)
    && /gte\(\s*budgetAllocations\.expiresAt/.test(inhalt);
  // TS-Form — die SIEBTE Fassung stand direkt neben der umgestellten, in
  // reinem TypeScript statt Drizzle, und der Waechter konnte sie per
  // Konstruktion nicht sehen (Gate 2 zu #166, S7):
  //   a.validFrom <= x && (!a.expiresAt || a.expiresAt >= x)
  const ts = /\.validFrom\s*<=/.test(inhalt) && /\.expiresAt\s*>=/.test(inhalt);
  return drizzle || ts;
}

describe("Budget-Gültigkeitsfenster — eine SSoT, kein Nachbau", () => {
  it("AW-1 – niemand schreibt das Fenster selbst", () => {
    const verstoesse: string[] = [];
    for (const wurzel of WURZELN) {
      for (const datei of dateienUnter(wurzel)) {
        const relativ = datei.replace(/\\/g, "/");
        if (ERLAUBT.has(relativ)) continue;
        if (hatHandgeschriebenesFenster(readFileSync(datei, "utf8"))) verstoesse.push(relativ);
      }
    }
    expect(
      verstoesse,
      "Gültigkeitsfenster handgeschrieben statt `allocationValidAtWhere` gerufen — "
      + "sechs Fassungen derselben Regel waren der Grund für diesen Wächter",
    ).toEqual([]);
  });

  it("AW-2 – der Wächter erkennt das Muster überhaupt", () => {
    // Gegenprobe. Ohne sie wäre AW-1 auch dann grün, wenn die Erkennung
    // kaputt ist — ein Wächter, der nie anschlägt, ist von einem ohne
    // Verstöße nicht zu unterscheiden.
    const nachbau = `
      import { budgetAllocations } from "@shared/schema";
      const w = and(
        lte(budgetAllocations.validFrom, asOf),
        or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, asOf)),
      );
    `;
    expect(hatHandgeschriebenesFenster(nachbau), "der Wächter sieht den Drizzle-Nachbau nicht").toBe(true);

    // Und die TS-Form, die er in der ersten Fassung nicht sehen KONNTE.
    const tsNachbau = `
      const gueltig = rows.filter(a =>
        a.validFrom <= asOf && (!a.expiresAt || a.expiresAt >= asOf));
    `;
    expect(hatHandgeschriebenesFenster(tsNachbau), "der Wächter sieht die TS-Form nicht").toBe(true);
    expect(hatHandgeschriebenesFenster("const x = 1;")).toBe(false);
  });

  it("AW-3 – die SSoT selbst trägt beide Welten", () => {
    // TS-Prädikat UND Drizzle-Bedingung müssen aus derselben Datei kommen.
    // Lägen sie auseinander, wäre der Zweitbegriff nur umgezogen.
    const ssot = readFileSync(SSOT, "utf8");
    expect(ssot).toContain("export function allocationValidAt(");
    expect(ssot).toContain("export function allocationValidAtWhere(");
    expect(ssot).toContain("export function displacedByReset(");
    // Nachgezogen (Gate 2 zu #174, S2): `ssot-registry.test.ts` prueft nur
    // Registry→Code, nicht Code→Registry. Zwei neue kanonische Funktionen in
    // derselben Datei blieben deshalb unbemerkt aussen vor — ein Katalog, der
    // nicht vollstaendig ist, laesst genau die Luecken zu, gegen die es ihn gibt.
    expect(ssot).toContain("export function notDisplacedByResetWhere(");
    expect(ssot).toContain("export function resetAnchorFrom(");
  });
});
