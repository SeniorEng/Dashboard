import type { MonthlyServiceRecord } from "@shared/schema";
import { wartetAufUnterschrift } from "./proof-status";

export interface PendingBannerOverviewItem {
  customerId: number;
  undocumentedCount: number;
  uncoveredDocumentedCount: number;
  /**
   * Die Sammel-Nachweise des Kunden im gewählten Monat. Gebraucht wird nur die
   * `id` und der `status` — daran hängt, ob der Übersichts-Abschnitt den
   * Nachweis bereits als eigene Karte zeigt.
   */
  monthlyRecords: { id: number; status: string }[];
}

/**
 * Welche wartenden Sammel-Nachweise gehören ins Hinweis-Banner?
 *
 * ── Die Regel, und warum sie sich geändert hat ──────────────────────────
 * Das Banner ist die Auffanglinie für Nachweise, die die Übersicht NICHT
 * sichtbar macht. Es darf deshalb genau das zeigen, was der Abschnitt „Wartet
 * auf Unterschrift" nicht zeigt — sonst steht derselbe Nachweis zweimal auf
 * dem Bildschirm.
 *
 * Vorher wurde das über eine NACHGEBAUTE Regel entschieden: „Kunde hat keine
 * offene Arbeit" — dieselbe Bedingung, mit der `bucketize` die Zustands-
 * Abschnitte unterdrückte. Das funktionierte nur, solange beide Kopien gleich
 * blieben. Mit #1914 fällt die Unterdrückung weg: der Abschnitt zeigt jetzt
 * JEDEN wartenden Nachweis, auch neben offener Arbeit. Die nachgebaute Regel
 * hätte den Nachweis weiterhin zusätzlich ins Banner gehoben — doppelt.
 *
 * Jetzt wird nicht mehr nachgebaut, sondern dieselbe Frage gestellt: welche
 * Nachweis-IDs zeigt der Abschnitt? Beide Seiten lesen dafür
 * `wartetAufUnterschrift`. Ein Auseinanderlaufen ist damit nicht mehr eine
 * Frage der Disziplin, sondern strukturell ausgeschlossen.
 *
 * Unverändert: auf einer kunden-gefilterten Seite zeigt das Banner nichts
 * (dort ist der Nachweis ohnehin im Blick), und Nachweise aus anderen Monaten
 * bleiben immer sichtbar — die Übersicht zeigt nur den gewählten Monat.
 */
export function computeVisiblePendingRecords(
  pendingRecords: MonthlyServiceRecord[] | undefined,
  selectedYear: number,
  selectedMonth: number,
  customerId: number | null,
  overview?: PendingBannerOverviewItem[],
): MonthlyServiceRecord[] {
  if (customerId) return [];
  const records = pendingRecords ?? [];

  // Genau die Nachweise, für die der Abschnitt eine eigene Karte rendert
  // (`pendingProofsOf` in `overview-sections.tsx` filtert nach derselben
  // Bedingung). Keine Kunden-Menge mehr, sondern eine Nachweis-Menge: ein Kunde
  // kann einen fertigen und einen wartenden Nachweis zugleich haben, und dann
  // ist die Frage „zeigt der Abschnitt DIESEN Nachweis?" die einzig richtige.
  const imAbschnittGezeigt = new Set<number>();
  for (const item of overview ?? []) {
    for (const record of item.monthlyRecords) {
      if (wartetAufUnterschrift(record.status)) imAbschnittGezeigt.add(record.id);
    }
  }

  return records.filter((r) => {
    if (r.year !== selectedYear || r.month !== selectedMonth) return true;
    return !imAbschnittGezeigt.has(r.id);
  });
}
