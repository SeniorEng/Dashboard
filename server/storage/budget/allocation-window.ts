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
 *   summary-queries.ts      `getAvailableCarryoverCents`
 *   summary-queries.ts      `allocValidWhere`
 *   consumption-engine.ts   Spezial-Allocations
 *
 * Alle fuenf SQL-Fassungen bilden **nur das Zeitfenster** nach. Solange die
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
import { and, gte, isNull, lte, or, type SQL } from "drizzle-orm";
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
 * verdraengen, nie mehr, und ist auf konsistenten Daten
 * (`year === Jahr(validFrom)`, von allen vier Schreibpfaden eingehalten)
 * wirkungslos — dort folgt `year <= reset.year` bereits aus
 * `validFrom < reset.cutoffDate`.
 */
export function displacedByReset(
  row: AllocationWindowRow & { year: number },
  reset: ResetAnchor | null,
): boolean {
  if (!reset) return false;
  return row.validFrom < reset.cutoffDate && row.year <= reset.year;
}
