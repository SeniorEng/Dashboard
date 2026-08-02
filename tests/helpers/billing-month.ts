/**
 * Referenz-„heute" für Abrechnungs-Fixtures.
 *
 * ERSETZT das direkte `new Date()` in den Billing-Fixtures, die einen
 * VERGANGENEN Werktags-Slot im laufenden Monat suchen (`createAppt`, 13 Dateien).
 *
 * Das Problem, das damit verschwindet: Die Fixtures suchen rückwärts vom heutigen
 * Tag bis zum Monatsersten. In den ersten Tagen eines Monats gibt es dort kaum —
 * und je nach Wochenlage GAR KEINEN — vergangenen Werktag. Am 01.08.2026 (Samstag)
 * und am 02.08.2026 (Sonntag) ist die Menge leer, die Fixtures scheitern mit
 * „kein freier Werktags-Slot im Monat gefunden", und ~30 Tests der Billing-/§45b-
 * Suite kippen auf rot, ohne dass sich eine Zeile Produktivcode geändert hat
 * (per A/B am 02.08.2026 gegen `3f98cb0a` belegt: identische Rot-Menge auf beiden
 * Ständen, also reiner Kalender-Effekt).
 *
 * Es ist dieselbe Familie wie die bekannte `getFutureDate`-Sa/So-Falle aus
 * CLAUDE.md, nur an der Monats- statt an der Wochenendgrenze.
 *
 * Die Lösung ist bewusst KEINE gefrorene Uhr: Diese Tests sprechen einen echten
 * App-Server an, der seine eigene Systemzeit liest. Ein `vi.setSystemTime` im
 * Testprozess würde die Fixture-Arithmetik verschieben, den Server aber nicht —
 * die beiden liefen auseinander, und der Server würde Termine ablehnen, die für
 * ihn in der Zukunft liegen. Stattdessen wird der ANKERTAG so gewählt, dass immer
 * genug vergangene Werktage existieren: heute, solange der laufende Monat sie
 * hergibt, sonst der letzte Tag des Vormonats.
 *
 * Die fachliche Aussage der Tests bleibt unberührt — sie rechnen weiterhin gegen
 * „einen abgeschlossenen Werktag in dem Monat, den sie abrechnen".
 */

/** So viele vergangene Werktage muss ein Monat bieten, damit die Fixtures ihre
 *  Termine (mehrere pro Test, je mit eigener Uhrzeit) unterbringen. */
const MIN_PAST_WEEKDAYS = 5;

/** Zählt die Werktage vom Monatsersten bis einschließlich des Stichtags. */
export function countPastWeekdaysInMonth(ref: Date): number {
  let n = 0;
  for (let day = 1; day <= ref.getDate(); day++) {
    const dow = new Date(ref.getFullYear(), ref.getMonth(), day).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/**
 * Ankertag für Fixtures, die einen vergangenen Werktags-Slot brauchen.
 *
 * Liefert `now`, wenn der laufende Monat mindestens `MIN_PAST_WEEKDAYS`
 * vergangene Werktage hat — sonst den letzten Tag des Vormonats (12:00, damit
 * Vergleiche gegen Mitternachts-Daten eindeutig sind). Ein voller Vormonat hat
 * immer genug Werktage, das Ergebnis ist also an JEDEM Kalendertag brauchbar.
 */
export function billingReferenceDate(now: Date = new Date()): Date {
  if (countPastWeekdaysInMonth(now) >= MIN_PAST_WEEKDAYS) return now;
  return new Date(now.getFullYear(), now.getMonth(), 0, 12, 0, 0);
}

/** Abrechnungs-Monat (1-basiert) zum Ankertag — ersetzt
 *  `const now = new Date(); const year = now.getFullYear(); …`. */
export function billingReferenceMonth(now: Date = new Date()): {
  reference: Date;
  year: number;
  month: number;
} {
  const reference = billingReferenceDate(now);
  return {
    reference,
    year: reference.getFullYear(),
    month: reference.getMonth() + 1,
  };
}
