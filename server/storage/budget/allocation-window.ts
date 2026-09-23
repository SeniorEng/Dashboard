/**
 * SSoT: „Zaehlt diese Budget-Zuweisung zum Stichtag?"
 *
 * ── Warum es diese Datei gibt (P1 `6hXp9qMrXH2WGVVG`, Punkt 2) ──────────
 * Dieselbe fachliche Frage wurde an SIEBEN Stellen beantwortet — zweimal in
 * TypeScript innerhalb von `calculateAllocated45b`, fuenfmal als
 * handgeschriebenes SQL:
 *
 *   allocation-storage.ts   `carryoverCounted`   (die massgebliche Fassung)
 *   allocation-storage.ts   `manual_adjustment`-Zweig (TS, vierte Quelle)
 *   fifo-breakdown.ts       Uebertrags-Filter
 *   summary-queries.ts      `getTotalCarryoverCents`
 *   summary-queries.ts      `allocValidWhere`
 *   consumption-engine.ts   Spezial-Allocations
 *
 * Eine siebte stand hier bis zum 23.09.2026: `getAvailableCarryoverCents`.
 * Sie war **tot** — nicht exportiert, und im einzigen Bereich, in dem sie
 * erreichbar war, kam ihr Name genau einmal vor: in ihrer eigenen Signatur.
 * Sie duplizierte die Pro-Allocation-Rest-Mathematik, die `fifo-breakdown`
 * inline fuehrt, und wurde entfernt. Weder `knip` noch `eslint` sahen sie:
 * das eine sucht unbenutzte EXPORTE, das andere greift bei modulprivaten
 * Funktionen hier nicht.
 *
 * Alle SQL-Fassungen bilden **nur das Zeitfenster** nach. Solange die
 * massgebliche Fassung auch nur das Zeitfenster war, waren sie deckungsgleich
 * — und damit unauffaellig. Mit der Reset-Verdraengung ist sie es nicht mehr:
 * gemessen ergaebe `allocatedCur = A − allocatedCarry` dann **−1.048,00 EUR**,
 * und der Client filtert den negativen Topf ueber `p.allocatedCents > 0` still
 * weg.
 *
 * **Das ist der Drei-Schichten-Fall aus CLAUDE.md in Reinform:** eine Regel an
 * sechs Orten wird beim naechsten Mal an fuenfen geaendert. Sie stehen hier
 * jetzt einmal — als reines Praedikat fuer den TS-Pfad und als
 * Drizzle-Bedingung fuer die SQL-Pfade, aus derselben Beschreibung.
 *
 * Bewusst NICHT hier: `ibCounted` (Startwerte) und `supersededIbYears`. Die
 * beantworten andere Fragen (Reset-Baseline bzw. Doppelzaehlung) und haben je
 * genau einen Aufrufer.
 */
import { and, gt, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import { budgetAllocations } from "@shared/schema";

/** Zeitliche Gueltigkeit einer Zuweisung — die Felder, die beide Welten lesen. */
export interface AllocationWindowRow {
  validFrom: string;
  expiresAt: string | null;
}

/**
 * Der Reset-Anker, gegen den verdraengt wird.
 *
 * ZWEI Groessen, nicht eine — und das ist der Kern von VD-5: der
 * `allocStart`-Shift liest `year`, die Verdraengung las `validFrom`. Zwei
 * Felder fuer zwei Entscheidungen ueber dieselbe Zeile. Laeuft beides
 * auseinander, faellt mit dem Uebertrag eine Schranke weg, die mit dem Reset
 * nichts zu tun hatte — gemessen **+343,00 EUR** statt der erwarteten Senkung.
 */
export interface ResetAnchor {
  /** Monatsanfang des spaetesten wirksamen Startwert-Monats (`yyyy-mm-01`). */
  cutoffDate: string;
  /** Jahr desselben Startwerts. */
  year: number;
  /**
   * Monat desselben Startwerts (1–12).
   *
   * Steht hier, statt beim Aufrufer aus `cutoffDate` zurueckgeparst zu werden.
   * Dieselbe Begruendung wie bei `resetYear` in `Allocated45bResult`: die
   * Groesse existiert bei der Berechnung bereits, und eine zweite Ableitung
   * haelt nur so lange, wie das Datumsformat bleibt.
   */
  month: number;
}

/**
 * Liegt die Zuweisung zum Stichtag im Gueltigkeitsfenster?
 *
 * `expiresAt === null` heisst „laeuft nicht ab" — nicht „abgelaufen".
 */
export function allocationValidAt(
  row: AllocationWindowRow,
  asOfDate: string,
  /**
   * Stichtag fuer die VERFALLS-Seite, falls er vom Fenster-Stichtag abweicht.
   *
   * Normalfall: identisch. `calculateAllocated45b` hat ohne `asOfDate` eine
   * geerbte **Asymmetrie** — `validFrom` gegen das Jahresende, `expiresAt`
   * gegen den Jahresanfang. Sie steht hier als Parameter, statt beim Aufrufer
   * als handgeschriebener Vergleich: sonst faellt genau dieser Aufrufer aus
   * der SSoT heraus, und der Waechter kann ihn nicht mehr schuetzen.
   *
   * Die erste Fassung dieser Umstellung hat die Asymmetrie eingeebnet und
   * damit ein Verhalten geaendert, das ein Kommentar als unveraendert auswies
   * (Gate 2 zu #166, S2). Sichtbar als Parameter kann das nicht mehr still
   * passieren.
   */
  verfallStichtag: string = asOfDate,
): boolean {
  if (row.validFrom > asOfDate) return false;
  return row.expiresAt == null || row.expiresAt >= verfallStichtag;
}

/** Dieselbe Regel als Drizzle-Bedingung, fuer die SQL-Pfade. */
export function allocationValidAtWhere(asOfDate: string): SQL | undefined {
  return and(
    lte(budgetAllocations.validFrom, asOfDate),
    or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, asOfDate)),
  );
}

/**
 * Verdraengt der Startwert-Reset diese Zuweisung?
 *
 * Nur wenn **BEIDE** Anker vor dem Reset liegen (VD-5). Das ist eine
 * VERENGUNG gegenueber „`validFrom` vor dem Reset": sie kann nur weniger
 * verdraengen, nie mehr.
 *
 * ── WANN sie ueberhaupt greift ──────────────────────────────────────────
 * `reset.year` ist per Konstruktion `Jahr(reset.cutoffDate)` — der Anker baut
 * beide aus derselben Zahl. Ist die erste Bedingung erfuellt, folgt daraus
 * `Jahr(validFrom) <= reset.year`.
 *
 * Fuer jede Zeile mit `year <= Jahr(validFrom)` ist die zweite Bedingung damit
 * **automatisch** erfuellt: die Verengung kann dort nichts verhindern. Sie
 * greift erst, wenn `year` GROESSER ist als das Jahr des `validFrom`.
 *
 * Durchgerechnet (153 verdraengende Konstellationen je Delta, wobei
 * Delta = `year − Jahr(validFrom)`):
 *
 *     Delta −2 / −1 / 0 :  0 verhindert
 *     Delta +1          : 33 verhindert
 *     Delta +2          : 93 verhindert
 *
 * **Im Produktivbestand (Stand 23.09.2026) kommen nur Delta 0 und Delta −1
 * vor — die Verengung wirkt dort auf KEINE Zeile.** Delta +1, die im
 * `carryoverTargetYear`-Docblock beschriebene Zieljahr-Semantik, tritt kein
 * einziges Mal auf (Ticket `6hcCCrWgXCH2XxXp`).
 *
 * Diese Praezisierung steht hier, weil die vorige Fassung („wirkungslos auf
 * konsistenten Daten, `year === Jahr(validFrom)`") zwar zutraf, aber zu eng
 * gefasst war: sie liess offen, was bei Delta −1 passiert, und genau daraus
 * ist die falsche Annahme entstanden, die 26 Prod-Zeilen seien betroffen und
 * die Messung deshalb eine Untergrenze. Sie ist es nicht.
 */
export function displacedByReset(
  row: AllocationWindowRow & { year: number },
  reset: ResetAnchor | null,
): boolean {
  if (!reset) return false;
  /**
   * `<=`, nicht `<` (Alriks Entscheidung, 22.09.2026).
   *
   * Eine Inventur zum 01.01. stellt den Bestand fest, und ein Uebertrag, der
   * am selben Tag beginnt, ist Teil dessen, was festgestellt wurde.
   *
   * Mit `<` griff die Regel ausgerechnet im HAEUFIGSTEN Fall nie:
   * Jahreswechsel, Uebertrag ab 01.01., Inventur im Januar — `cutoffDate` ist
   * dann ebenfalls der 01.01., und `validFrom < cutoffDate` ist falsch.
   * Gemessen: `ohne=157200 mit=157200`, das Flag aenderte nichts. Genau die
   * Konstellation, fuer die der Mechanismus gemacht ist (Gate 2 zu #166, S3).
   *
   * **`<=` verdraengt MEHR als `<`.** Jede Messung, die mit `<` gefahren
   * wurde, ist damit eine Untergrenze.
   */
  return row.validFrom <= reset.cutoffDate && row.year <= reset.year;
}

/**
 * Dieselbe Regel als Drizzle-Bedingung — sie laesst durch, was `displacedByReset`
 * NICHT verdraengt.
 *
 * ── Warum es diese Funktion gibt ────────────────────────────────────────
 * #166 hat fuenf handgeschriebene SQL-Fassungen auf `allocationValidAtWhere`
 * gezogen. Das vereinheitlichte das ZEITFENSTER — die Verdraengung blieb
 * aussen vor, weil sie bis dahin nur im TS-Pfad existierte. Solange das Flag
 * aus ist, faellt das nicht auf; mit scharfer Verdraengung faellt
 * `allocatedCur = A − allocatedCarry` auf **−1.048,00 EUR** (gemessen, `SQ-1`),
 * und der Client filtert den negativen Topf ueber `p.allocatedCents > 0` still
 * weg. Der Fehler zeigt sich dann nicht als falsche Zahl, sondern als
 * FEHLENDE Zeile — und die sieht aus wie „kein Uebertrag vorhanden".
 *
 * `undefined` bei `reset === null`: keine Bedingung, nicht „nichts zaehlt".
 * Das entspricht `displacedByReset(row, null) === false`.
 *
 * ── NUR neben einem `source = 'carryover'`-Filter verwenden ────────────
 * Diese Bedingung ist die exakte Spiegelung von `displacedByReset`, und die
 * hat KEINE Quellen-Pruefung: im TS-Pfad steht sie innerhalb von
 * `carryoverCounted`, also hinter `source === "carryover"`. Die Quellen-Grenze
 * gehoert deshalb genauso auch hier zum Aufrufer.
 *
 * **Warum das wichtig ist:** der Startwert erfuellt die Bedingung woertlich —
 * fuer ihn gilt `validFrom == cutoffDate` und `year == reset.year`. In einer
 * Abfrage ohne Quellen-Filter wuerde die Inventur sich selbst loeschen.
 *
 * Eine Zwischenfassung trug die Grenze (`source <> 'carryover'`) in dieser
 * Funktion. Das war gut gemeint und in zweierlei Hinsicht falsch: es machte
 * zwei als Spiegel benannte Funktionen ungleich, und es war nach dem
 * B1-Fix von keinem Aufrufer mehr erreichbar — alle drei filtern auf
 * `carryover`. Eine Bedingung, die kein Aufruf je ausloest, ist keine
 * Absicherung, sondern eine Zusage ohne Beleg (Gate 2 zu #174).
 */
export function notDisplacedByResetWhere(reset: ResetAnchor | null): SQL | undefined {
  if (!reset) return undefined;
  // Negation von `validFrom <= cutoff AND year <= resetYear`.
  return or(
    gt(budgetAllocations.validFrom, reset.cutoffDate),
    gt(budgetAllocations.year, reset.year),
  );
}

/**
 * Welcher Startwert ist der Reset-Anker? — die Regel, einmal.
 *
 * Der SPAETESTE zum Stichtag bereits wirksame Startwert-Monat ist die neue
 * Basis (#1812). Ein rein zukuenftiger Startwert loest keinen Reset aus, damit
 * rueckwirkende Reads korrekt bleiben.
 *
 * Stand vorher als Schleife in `calculateAllocated45b`. Sie muss jetzt von
 * ZWEI Seiten gelesen werden — dem TS-Pfad und den SQL-Pfaden —, und genau an
 * dieser Stelle entstuende sonst die sechste Fassung derselben Frage.
 *
 * **Der `{year}`-Pool-Modus hat keinen Reset** und ruft diese Funktion gar
 * nicht erst; das bleibt beim Aufrufer, weil es eine Aussage ueber die
 * gestellte FRAGE ist („wie hoch war der Anspruch des Jahres Y?") und nicht
 * ueber die Zuweisungen.
 */
export function resetAnchorFrom(
  initialBalanceMonths: readonly { year: number; month: number }[],
  resetDateLimit: string,
): ResetAnchor | null {
  let jahr = 0;
  let monat = 0;
  let gefunden = false;
  for (const ib of initialBalanceMonths) {
    const beginn = `${ib.year}-${String(ib.month).padStart(2, "0")}-01`;
    if (beginn > resetDateLimit) continue;
    if (!gefunden || ib.year > jahr || (ib.year === jahr && ib.month > monat)) {
      jahr = ib.year;
      monat = ib.month;
      gefunden = true;
    }
  }
  if (!gefunden) return null;
  return {
    cutoffDate: `${jahr}-${String(monat).padStart(2, "0")}-01`,
    year: jahr,
    month: monat,
  };
}
