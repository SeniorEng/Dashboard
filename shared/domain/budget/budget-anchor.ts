/**
 * Task #1192 — SSoT für den Budget-Anker.
 *
 * Der Budget-Anker ist das Datum, ab dem virtuelle §45b-Monatsallokationen
 * laufen und ab dem §45a/§39 ihre Monats-/Jahresansammlung zählen. Er wurde
 * historisch je nach Pfad unterschiedlich, falsch oder gar nicht persistiert.
 * Seit Task #1204 wird er NICHT mehr gespeichert, sondern zur LAUFZEIT pro Topf
 * aus der Pflegegrad-Historie abgeleitet (siehe
 * `server/storage/budget/allocation-storage.ts`).
 *
 * Diese eine reine Funktion ist die SSoT-Definition der Anker-Regeln R1–R3. Sie
 * leitet den Anker AUSSCHLIESSLICH aus der Pflegegrad-Historie ab — es gibt
 * keinen manuellen Anker mehr (R4).
 *
 * Regeln:
 *  - **R1 (Neuanlage):** Anker = `max(frühester pflegegradSeit, 01.01. des
 *    laufenden Jahres)`. Liegt der Pflegegrad-Beginn im Vorjahr oder früher,
 *    ist der Anker der 01.01. des laufenden Jahres; Vorjahres-Ansprüche werden
 *    nie automatisch akkumuliert (nur über manuell erfassten Carryover).
 *  - **R2 (PG-Wechsel):** Eine PG-Änderung verschiebt den Anker nie — dies ist
 *    inhärent erfüllt, weil immer der FRÜHESTE `validFrom` der Historie gewählt
 *    wird, unabhängig von späteren Phasen.
 *  - **R3 (Erst-PG):** Ein erstmaliger Pflegegrad setzt den Anker nach R1; gibt
 *    es noch keine Historie, ist der Anker `null` (Aufrufer fallen dann auf ihre
 *    topf-spezifischen Fallbacks zurück bzw. setzen keinen Anker).
 *
 * Reiner Wert, keine Seiteneffekte, reihenfolge-unabhängig.
 *
 * @param careLevelHistory Pflegegrad-Historie (jede Zeile mit `validFrom` als
 *   ISO-Datum `YYYY-MM-DD`). Auf-/absteigend sortiert egal.
 * @param today ISO-Datum (`YYYY-MM-DD`) des „heute"; bestimmt das laufende Jahr
 *   für den Floor.
 * @returns ISO-Datum (`YYYY-MM-DD`) des Ankers oder `null`, wenn keine gültige
 *   Pflegegrad-Zeile existiert.
 */
export function resolveBudgetAnchor(
  careLevelHistory: ReadonlyArray<{ validFrom?: string | null }>,
  today: string,
): string | null {
  let earliest: string | undefined;
  for (const row of careLevelHistory) {
    const validFrom = row?.validFrom;
    if (!validFrom) continue;
    if (earliest === undefined || validFrom < earliest) {
      earliest = validFrom;
    }
  }
  if (earliest === undefined) return null;

  // R1-Floor: nie vor den 01.01. des laufenden Jahres. ISO-Datums-Strings sind
  // lexikografisch vergleichbar, daher genügt der String-Vergleich.
  const jan1CurrentYear = `${today.slice(0, 4)}-01-01`;
  return earliest < jan1CurrentYear ? jan1CurrentYear : earliest;
}
