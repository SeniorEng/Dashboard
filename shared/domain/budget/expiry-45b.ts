/**
 * SSoT für die §45b-VERFALLSFRIST: „wann verfällt ein Übertrag, und ab welchem
 * Jahr trägt eine Monatsaufstockung zum Stichtag noch bei?"
 *
 * SGB XI §45b Abs. 3: der Übertrag aus Jahr Y gilt im Folgejahr und verfällt
 * strikt zum 30.06. Diese eine Frist war an FÜNF Stellen unabhängig kodiert,
 * die einander nicht kannten:
 *
 *  - `shared/domain/budget-carryover-dedup.ts` — das Literal `${targetYear}-06-30`
 *    im Übertrags-Fenster (`carryoverWindowFor`).
 *  - `server/storage/budget/allocation-storage.ts` — gleich ZWEIMAL: der nackte
 *    Ausdruck `horizonMonth <= 6 ? …` als Verfalls-Boden und noch einmal das
 *    Literal beim Insert des Auto-Übertrags.
 *  - `server/services/budget-initial-setup.ts` — der Wizard-Übertrag.
 *  - `server/services/invoice-45b-reduction.ts` — der Kürzungs-Startwert.
 *
 * Zwei nannte der Gate-1-Plan, die dritte fand der Rückfall-Wächter dieses PRs,
 * die letzten beiden der Gate-2-Review. Die Zahl ist hier bewusst genannt: sie
 * ist das Argument für die Registrierung in `shared/ssot-registry.ts`
 * (`budget-45b-expiry`) — Kopien, die niemand zählt, sind genau das Problem.
 *
 * ERSETZT alle fünf. Wer die Frist verschiebt, fasst ab jetzt eine Konstante an und
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
 *
 * ── GRENZE der Kopplung (Gate-2-Fund N1) ────────────────────────────────
 * Gekoppelt ist nur die MONATS-Achse. `CARRYOVER_45B_EXPIRY_DAY` geht in diese
 * Ableitung NICHT ein: bei einer Frist zum 15.06. läge der Übertrag ab dem
 * 16.06. tot, diese Funktion gäbe für Juni aber weiter `Y-1` zurück und die
 * Vorjahres-Aufstockungen blieben zwei Wochen zu lang im Topf. Die Ableitung
 * gilt also nur, solange `DAY` der LETZTE Tag von `MONTH` ist — was bei §45b
 * der Fall ist und absehbar bleibt. Wer das ändert, muss hier auf ein volles
 * ISO-Datum umstellen statt nur die Konstante zu drehen.
 */
export function expiry45bFloorYearFor(horizonYear: number, horizonMonth: number): number {
  return horizonMonth <= CARRYOVER_45B_EXPIRY_MONTH ? horizonYear - 1 : horizonYear;
}
