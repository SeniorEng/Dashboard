/**
 * SSoT: **Wartet dieser Leistungsnachweis noch auf eine Unterschrift?**
 *
 * ── Warum das eine eigene Funktion ist ──────────────────────────────────
 * Die Frage wird an ZWEI Stellen gestellt, die im Gleichschritt bleiben müssen:
 *
 *   - `bucketize` entscheidet damit, ob ein Kunde im Abschnitt „Wartet auf
 *     Unterschrift" erscheint (und `pendingProofsOf`, welche Karten er dort
 *     bekommt).
 *   - `computeVisiblePendingRecords` entscheidet damit, welche Nachweise das
 *     Hinweis-Banner NICHT mehr zeigen darf, weil der Abschnitt sie schon zeigt.
 *
 * Laufen die beiden auseinander, erscheint derselbe Nachweis doppelt (Banner
 * UND Abschnitt) oder gar nicht. Genau das ist beim Entkoppeln der Abschnitte
 * passiert: das Banner spiegelte die Unterdrückungs-Regel von `bucketize` nach,
 * statt dieselbe Frage zu stellen — und als die Regel wegfiel, zeigte es weiter,
 * was der Abschnitt inzwischen auch zeigte.
 *
 * `completed` ist der einzige Endzustand eines Nachweises; alles andere
 * (`pending`, `employee_signed`, …) wartet noch auf jemanden.
 */
export function wartetAufUnterschrift(status: string): boolean {
  return status !== "completed";
}
