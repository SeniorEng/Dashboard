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
 * Verfalls-BODEN zum Horizont als DATUM: der früheste Stichtag, ab dem Mittel
 * noch beitragen.
 *
 * Im ersten Halbjahr trägt das Vorjahr noch bei — sein Übertrag lebt bis zum
 * 30.06. Ab dem 01.07. ist er verfallen, und nur noch das laufende Jahr zählt.
 * Deshalb hängt der Boden am selben Monat wie die Frist oben und wird hier aus
 * derselben Konstante abgeleitet, statt die `6` ein zweites Mal hinzuschreiben.
 *
 * ── ERSETZT `expiry45bFloorYearFor` (monatsgenau, entfernt) ─────────────
 * Die frühere Fassung gab ein JAHR zurück und verglich `horizonMonth <= 6`.
 * Sie trug damit die im Gate-2 als N1 benannte Kopplungs-GRENZE: gekoppelt war
 * allein die MONATS-Achse, `CARRYOVER_45B_EXPIRY_DAY` ging nicht ein. Bei einer
 * Frist zum 15.06. läge der Übertrag ab dem 16.06. tot, sie gäbe für Juni aber
 * weiter `Y-1` zurück.
 *
 * Sie ist ERSATZLOS ENTFERNT statt daneben stehen zu bleiben. Ihr einziger
 * verbliebener Aufrufer (`server/scripts/verify-45b-consistency.ts`) braucht
 * nur das Jahr und schneidet es aus diesem Datum. Zwei exportierte Böden
 * nebeneinander — einer mit bekannter Lücke — wären genau das „kommt
 * zusätzlich hinzu", das die Arbeitsregeln verbieten.
 *
 * Zwei Gründe, warum das eine Verbesserung ist und nicht nur eine Umformung:
 *
 *  1. **Der Tag zählt jetzt wirklich.** Verglichen wird der volle Horizont
 *     gegen `carryoverExpiresAtFor(Jahr)` — also gegen die Frist selbst, nicht
 *     gegen ihren Monat. Damit ist die oben beschriebene Grenze N1 geschlossen:
 *     wer `CARRYOVER_45B_EXPIRY_DAY` auf den 15. dreht, bewegt Boden und Frist
 *     zusammen. Vorher hätte er sie gegeneinander laufen lassen.
 *  2. **Es gibt keinen zweiten Ort mehr, an dem aus dem Boden ein Datum wird.**
 *     Der Lesepfad baute den String selbst — der Boden war damit an zwei
 *     Stellen halb kodiert (Jahr hier, Monat/Tag dort).
 *
 * Bei den heutigen Konstanten (`DAY` = letzter Tag von `MONTH`) liefert die
 * Funktion für jeden Horizont dasselbe Boden-Jahr wie zuvor. Das ist
 * beabsichtigt: der Halbjahres-Split dieses PR sitzt NICHT hier, sondern in der
 * Übertrags-Anlage (`computeCarryoverPhantom`). Diese Funktion ist der
 * strukturelle Träger dafür — sie ändert für sich genommen kein Geld.
 *
 * `horizonIso` ist ein voller `YYYY-MM-DD`-Stichtag.
 */
export function expiry45bFloorDateFor(horizonIso: string): string {
  const horizonJahr = Number(horizonIso.slice(0, 4));
  // `<=` statt `<`: am 30.06. gilt der Übertrag noch, erst ab dem 01.07. ist er
  // verfallen. Deckungsgleich zu `processExpiredCarryover` (`expiresAt < today`)
  // und zum Zähl-Prädikat `carryoverCounted` (`expiresAt >= asOf`).
  const bodenJahr = horizonIso <= carryoverExpiresAtFor(horizonJahr)
    ? horizonJahr - 1
    : horizonJahr;
  return `${bodenJahr}-01-01`;
}
