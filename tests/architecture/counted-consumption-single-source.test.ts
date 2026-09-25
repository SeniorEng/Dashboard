import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { collectScanFiles, stripComments } from "./guard-helpers";

/**
 * Wächter: der §45b-Verbrauchs-Schnitt wird NICHT handgeschrieben.
 *
 * ── Warum es diesen Wächter gibt (Gate 2 zu #190, S2) ──────────────────
 * Die Frage „zählt diese BUCHUNG zum Stichtag?" ist die Schwester der Frage
 * „zählt diese ZUWEISUNG zum Stichtag?" (`allocation-window-single-source`).
 * Sie hat denselben Verlauf genommen, nur schneller.
 *
 * `classifyConsumedByState` trug die DRITTE Fassung — in derselben Datei,
 * 140 Zeilen unter der zweiten, nur mit `lte(transactionDate, asOfDate)`.
 * Solange beide Seiten UNgeschnitten waren, stimmten sie überein und waren
 * unauffällig. Der Fix schnitt die eine und ließ die andere stehen; gemessen
 * an einem dokumentierten Termin über 100,00 €:
 *
 *     vorher  verbr 100,00  dok 100,00  sonst    0,00  rest 400,00
 *     nachher verbr   0,00  dok 100,00  sonst −100,00  rest 500,00
 *
 * Das ist derselbe Mechanismus wie bei den sechs Fenster-Fassungen: **die
 * Gefahr ist nicht der heutige Unterschied, sondern die nächste Änderung,
 * die nur eine Seite trifft.**
 *
 * ── Warum die Zusage auf der FUNDSTELLE sitzt, nicht auf der DATEI ─────
 * Gemessen (25.09.2026): fünf Dateien unter `server/storage/budget` nennen
 * `entlastungsbetrag_45b` UND eine obere Datumsschranke auf
 * `budgetTransactions` — `rebook-storage`, `summary-queries`,
 * `allocation-storage`, `consumption-engine`, `cap-calculator`. Sie
 * beantworten verschiedene Fragen (Monatsfenster beim Umbuchen, Deckel,
 * Monats-Engine). Ein datei-weiter Wächter bräuchte eine Allow-List aus
 * genau diesen fünf und sagte damit nichts mehr.
 *
 * Die Zusage lautet deshalb enger und trägt trotzdem: **wer den Schnitt
 * einmal ruft, ruft ihn überall.** Eine Datei, die `countedConsumptionWhere`
 * benutzt, ist auf dem Stichtags-Leseweg; eine nackte Schranke daneben ist
 * dort per Konstruktion die nächste abweichende Fassung. Genau B1s Form.
 *
 * Der Kreis wächst von selbst mit: jede künftige Datei, die den Schnitt
 * übernimmt, fällt ab diesem Moment unter die Zusage.
 *
 * ── Was dieser Wächter NICHT hält ─────────────────────────────────────
 * `allocation-storage.ts` (der Reader) formuliert dieselbe Frage **invers**:
 * er rechnet nicht „was zählt", sondern `excludedConsumedNetCents` — „was
 * ist auszunehmen" — über drei Ausschluss-Glieder, von denen
 * `countedConsumptionWhere` zwei spiegelt (das dritte, die Sonder-Zuweisungen,
 * ist allocation-spezifisch und gehört zum Aufrufer). Zwei Formulierungen
 * derselben Frage sind ein Zweitbegriff; textlich ist er nicht zu fassen.
 * Er steht als offener Punkt in der Wirkungskarte (`#188`), nicht als stille
 * Lücke hier.
 *
 * Und die Zusage deckt heute **genau eine Datei** ab, weil nur eine den
 * Schnitt ruft. Wandert `classifyConsumedByState` später in eine eigene
 * Datei, ohne die SSoT zu importieren, **schweigt dieser Wächter** — er
 * findet niemanden, den er prüfen könnte. `VS-1` fängt genau das über
 * `PFLICHT_MITGLIED` ab, aber nur für die heute bekannte Datei.
 */

const SSOT = "server/storage/budget/allocation-window.ts";
const SCHNITT = "countedConsumptionWhere";

/**
 * Die Datei muss unter der Zusage stehen, sonst ist der Wächter leer.
 * Ohne diese Verankerung würde ein Entfernen des Imports den Wächter still
 * grün stellen — dieselbe Klasse wie ein Muster, das nichts mehr findet.
 */
const PFLICHT_MITGLIED = "server/storage/budget/fifo-breakdown.ts";

/**
 * Nackte obere Datumsschranke auf `budgetTransactions`.
 *
 * Läuft über NORMALISIERTE Zwischenräume, nicht zeilenweise. Ein Wächter auf
 * Zeilen ist für TypeScript fast immer zu eng — die Verletzung
 *
 *     lte(
 *       budgetTransactions.transactionDate,
 *       asOfDate,
 *     )
 *
 * wäre an einem Zeilen-Regex vorbeigelaufen, und der Wächter hätte
 * ausgesehen, als hielte er die Zusage (CLAUDE.md, „Ein Wächter braucht eine
 * Selbstprobe").
 */
function nackteSchranken(inhalt: string): string[] {
  const text = stripComments(inhalt).replace(/\s+/g, " ");
  const treffer: string[] = [];
  // Drizzle-Form, `lte(` und `lt(` — beide sind eine obere Schranke.
  for (const m of text.matchAll(/\blte?\(\s*budgetTransactions\.transactionDate[^)]*\)/g)) {
    treffer.push(m[0].trim());
  }
  /**
   * TS- UND `sql`-Template-Form.
   *
   * Die Template-Form war in der ersten Fassung nicht erkannt (Gate 2 zu
   * #190, S-2) — und sie ist nicht theoretisch: **so schreibt der kanonische
   * Reader genau dieses Praedikat** (`unified-reader.ts:134` und `:142`), und
   * `fifo-breakdown.ts` benutzt `sql`-Templates direkt daneben. Ein Verstoss
   * in der Datei, die den Schnitt ruft, waere in dieser Schreibweise gruen
   * geblieben.
   *
   *     sql`${budgetTransactions.transactionDate} <= ${asOfDate}`
   *                                             ^^ hier steht ein `}`
   */
  for (const m of text.matchAll(/budgetTransactions\.transactionDate\s*\}?\s*<=?[^;,)]*/g)) {
    treffer.push(m[0].trim());
  }
  return treffer;
}

describe("§45b-Verbrauchs-Schnitt — eine SSoT, kein Nachbau", () => {
  it("VS-1 – wer den Schnitt ruft, schreibt daneben keine eigene Schranke", () => {
    const dateien = collectScanFiles(["server", "shared"])
      .filter(f => f.rel !== SSOT)
      .filter(f => stripComments(f.content).includes(SCHNITT));

    expect(
      dateien.map(f => f.rel),
      `kein Verbraucher von \`${SCHNITT}\` gefunden — der Wächter scannt nichts`,
    ).toContain(PFLICHT_MITGLIED);

    const verstoesse: string[] = [];
    for (const f of dateien) {
      for (const schranke of nackteSchranken(f.content)) {
        verstoesse.push(`${f.rel} — ${schranke}`);
      }
    }

    expect(
      verstoesse,
      `handgeschriebene Stichtags-Schranke neben \`${SCHNITT}\` — genau die Form, `
      + "in der B1 entstanden ist (dritte Fassung, 140 Zeilen unter der zweiten)",
    ).toEqual([]);
  });

  it("VS-2 – der Wächter erkennt das Muster überhaupt", () => {
    // Gegenprobe. Ohne sie wäre VS-1 auch dann grün, wenn die Erkennung
    // kaputt ist — und beide Zustände sähen von außen gleich aus.
    expect(
      nackteSchranken(`lte(budgetTransactions.transactionDate, asOfDate),`),
      "die einzeilige Drizzle-Form wird nicht erkannt",
    ).toHaveLength(1);

    // Die ÜBER ZEILEN UMGEBROCHENE Form. Ein Zeilen-Regex hätte sie
    // durchgelassen; sie ist die realistischere Schreibweise, sobald ein
    // Formatierer über die Datei läuft.
    expect(
      nackteSchranken(`
        const w = and(
          eq(budgetTransactions.customerId, customerId),
          lte(
            budgetTransactions.transactionDate,
            asOfDate,
          ),
        );
      `),
      "die umgebrochene Drizzle-Form wird nicht erkannt",
    ).toHaveLength(1);

    // Die TS-Form ohne Drizzle.
    expect(
      nackteSchranken(`const zaehlt = budgetTransactions.transactionDate <= asOfDate;`),
      "die TS-Form wird nicht erkannt",
    ).toHaveLength(1);

    // Die `sql`-Template-Form — so schreibt der kanonische Reader das
    // Praedikat. Sie blieb in der ersten Fassung unerkannt (S-2).
    expect(
      nackteSchranken("const w = sql`${budgetTransactions.transactionDate} <= ${asOfDate}`;"),
      "die sql-Template-Form wird nicht erkannt",
    ).toHaveLength(1);

    // `lt(` statt `lte(` — dieselbe Frage, eine Grenze weiter.
    expect(
      nackteSchranken(`lt(budgetTransactions.transactionDate, reset.cutoffDate)`),
      "die `lt`-Form wird nicht erkannt",
    ).toHaveLength(1);

    // Eine reine Erwähnung im Kommentar ist KEIN Verstoß — sonst wäre der
    // Docblock dieses Wächters selbst einer.
    expect(
      nackteSchranken(`// zählt über lte(budgetTransactions.transactionDate, asOfDate)`),
      "eine Kommentar-Erwähnung schlägt fälschlich an",
    ).toEqual([]);

    expect(nackteSchranken(`const x = 1;`)).toEqual([]);
  });

  it("VS-3 – der Verbrauchs-Schnitt hängt NICHT am Verdrängungs-Flag", () => {
    /**
     * Der Befund aus #190: es sind ZWEI Anker, nicht einer.
     *
     * `resetAnchor` steuert die VERDRÄNGUNG und hängt am Flag
     * `RESET_DISPLACES_ALL_SOURCES_DEFAULT` — ob ein Startwert ältere
     * Übertragszeilen verdrängt, ist eine fachliche Weiche.
     *
     * Der Verbrauchs-Anker steuert den SCHNITT und hängt NICHT am Flag: dass
     * ein Verbrauch, der aus dem Gesamt-Verbrauch herausfällt, auch aus der
     * Topf-Rechnung herausfallen muss, ist keine Weiche, sondern eine
     * Identität. Wer beide zusammenlegt, koppelt eine Zahl an einen Schalter,
     * der über eine andere Frage entscheidet — und der Flip bewegt dann die
     * eine Größe und die andere nicht.
     *
     * Geprüft wird der RUMPF, nicht die Datei: das Flag liegt legitim in
     * derselben SSoT, nur eben nicht in dieser Funktion.
     */
    const ssot = readFileSync(SSOT, "utf8");
    expect(ssot).toContain(`export function ${SCHNITT}(`);

    const norm = stripComments(ssot).replace(/\s+/g, " ");
    const start = norm.indexOf(`export function ${SCHNITT}(`);
    expect(start, "der Schnitt ist keine eigene exportierte Funktion mehr").toBeGreaterThan(-1);
    const rest = norm.slice(start + 1);
    const ende = rest.indexOf("export ");
    const rumpf = ende === -1 ? rest : rest.slice(0, ende);

    expect(
      rumpf.includes("RESET_DISPLACES_ALL_SOURCES_DEFAULT"),
      "der Verbrauchs-Schnitt liest das Verdrängungs-Flag — das sind zwei "
      + "verschiedene Fragen, und der Flip bewegt sonst nur eine der beiden Zahlen",
    ).toBe(false);
  });
});
