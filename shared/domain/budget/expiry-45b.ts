/**
 * SSoT für die §45b-VERFALLSFRIST: „wann verfällt ein Übertrag, und ab welchem
 * Jahr trägt eine Monatsaufstockung zum Stichtag noch bei?"
 *
 * SGB XI §45b Abs. 3: der Übertrag aus Jahr Y gilt im Folgejahr und verfällt
 * strikt zum 30.06. Diese eine Frist wurde bis hierher an ZWEI Stellen
 * unabhängig kodiert, die einander nicht kannten:
 *
 *  - `shared/domain/budget-carryover-dedup.ts` — das Literal `${targetYear}-06-30`
 *    im Übertrags-Fenster (`carryoverWindowFor`).
 *  - `server/storage/budget/allocation-storage.ts` — der nackte Ausdruck
 *    `horizonMonth <= 6 ? horizonYear - 1 : horizonYear` als Verfalls-Boden
 *    (`expiryFloorAnchorYear`).
 *
 * ERSETZT beide. Wer die Frist verschiebt, fasst ab jetzt eine Konstante an und
 * bewegt Fenster UND Boden zugleich; vorher hätte ein Halb-Umbau die beiden
 * gegeneinander laufen lassen, ohne dass irgendetwas gewarnt hätte.
 *
 * Rein und DB-frei, damit die Frist ohne Datenbank prüfbar bleibt — wie die
 * Anker-Kette nebenan (`anchor-45b.ts`).
 */

/** Monat, in dem der Übertrag verfällt (Juni). Inklusive. */
export const CARRYOVER_45B_EXPIRY_MONTH = 6;

/** Letzter Tag, an dem der Übertrag noch gilt (30.). Inklusive. */
export const CARRYOVER_45B_EXPIRY_DAY = 30;

function zweistellig(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Verfallsdatum des Übertrags für ein Zieljahr — der letzte Tag, an dem er noch
 * zählt (`2026 → "2026-06-30"`).
 */
export function carryoverExpiresAtFor(targetYear: number): string {
  return `${targetYear}-${zweistellig(CARRYOVER_45B_EXPIRY_MONTH)}-${zweistellig(CARRYOVER_45B_EXPIRY_DAY)}`;
}

/**
 * Verfalls-BODEN zum Horizont: das früheste Jahr, dessen Mittel zum Stichtag
 * noch beitragen.
 *
 * Im ersten Halbjahr trägt das Vorjahr noch bei — sein Übertrag lebt bis zum
 * 30.06. Ab dem 01.07. ist er verfallen, und nur noch das laufende Jahr zählt.
 * Deshalb hängt der Boden am selben Monat wie die Frist oben und wird hier aus
 * derselben Konstante abgeleitet, statt die `6` ein zweites Mal hinzuschreiben.
 *
 * `horizonMonth` ist 1-basiert.
 */
export function expiry45bFloorYearFor(horizonYear: number, horizonMonth: number): number {
  return horizonMonth <= CARRYOVER_45B_EXPIRY_MONTH ? horizonYear - 1 : horizonYear;
}
