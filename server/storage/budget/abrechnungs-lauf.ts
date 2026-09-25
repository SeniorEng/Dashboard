/**
 * Ein Abrechnungs-Lauf über mehrere Termine: Reihenfolge und Topf-Fenster.
 *
 * ── Warum es diese Datei gibt ───────────────────────────────────────────
 * Nach einem Voll-Storno kommen die Termine einer Rechnung auf zwei Wegen
 * zurück in eine neue Rechnung:
 *
 *   · die VORSCHAU (`rederiveSplitFromCurrentAllocation`, `invoice-data.ts`)
 *     leitet die Aufteilung read-only ab und bucht nichts,
 *   · das ERSTELLEN (`rebookNetZeroAppointmentConsumption`,
 *     `rebook-storage.ts`) bucht Termin für Termin neu.
 *
 * Die Vorschau prüfte jeden Termin gegen die VOLLE Verfügbarkeit. Was ein
 * früherer Termin desselben Laufs schon beansprucht hatte, zog sie nicht ab.
 * Drei Termine, die einzeln in den Topf passen, passten damit zusammen auch —
 * die Vorschau zeigte mehr Kasse, als im Topf ist, und das Erstellen buchte
 * etwas anderes, als die Vorschau zeigte.
 *
 * Das Erstellen war kumulativ, aber nur zufällig: es bucht nacheinander, und
 * jede Buchung ist für die nächste schon im Ledger. Die REIHENFOLGE kam aus
 * `computeNetZeroApptIds` — also aus der Ladereihenfolge der Buchungen, nicht
 * aus dem Kalender.
 *
 * ── Die Regel (Tabelle D, Entscheidung Alrik, 25.09.2026) ────────────────
 *   · §45b: Summe über ALLE Termine des Laufs, chronologisch; jeder Termin
 *     sieht, was die früheren schon beansprucht haben.
 *   · §45a: dieselbe Summe, aber je KALENDERMONAT getrennt.
 *   · §39/§42a: NICHT entschieden. Hier wie §45b je Kalenderjahr behandelt,
 *     weil es ein Jahresbudget ist — als offene Bestätigung im PR vermerkt.
 *
 * ERSETZT: die unkumulierte Einzelprüfung in der Vorschau und die zufällige
 * Reihenfolge im Erstellen. Beide lesen jetzt `chronologischeReihenfolge`,
 * die Vorschau zusätzlich `fensterSchluessel`.
 */
import { inArray } from "drizzle-orm";
import { appointments } from "@shared/schema";
import { appointmentsRepo } from "../../repos";
import type { DbClient } from "./types";

/**
 * Termine eines Laufs in Kalender-Reihenfolge: Datum, dann Uhrzeit, dann ID.
 *
 * Die ID als letzter Schlüssel macht die Reihenfolge VOLLSTÄNDIG: zwei
 * Termine zur selben Zeit bekommen trotzdem eine feste Reihenfolge, und
 * Vorschau und Erstellen können nicht auseinanderlaufen, weil die Datenbank
 * gleichrangige Zeilen einmal so und einmal anders liefert.
 *
 * Unbekannte IDs (gelöscht/inaktiv) fallen heraus — dieselbe Menge, die beide
 * Aufrufer ohnehin nicht abrechnen.
 */
export async function chronologischeReihenfolge(
  apptIds: readonly number[],
  tx?: DbClient,
): Promise<number[]> {
  if (apptIds.length === 0) return [];
  const zeilen = await appointmentsRepo.selectColumnsFrom({
    id: appointments.id,
    date: appointments.date,
    scheduledStart: appointments.scheduledStart,
  }, tx)
    .where(inArray(appointments.id, [...apptIds]));
  return zeilen
    .map(z => ({
      id: z.id,
      date: typeof z.date === "string" ? z.date : String(z.date),
      start: z.scheduledStart ?? "",
    }))
    .sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.start.localeCompare(b.start)
      || a.id - b.id)
    .map(z => z.id);
}

/**
 * Das Fenster, in dem sich Beanspruchungen eines Topfes im selben Lauf
 * gegenseitig mindern (Tabelle D).
 *
 * Zwei Termine teilen sich den Topf genau dann, wenn ihr Schlüssel gleich ist.
 */
export function fensterSchluessel(budgetType: string, datum: string): string {
  switch (budgetType) {
    // §45b: ein fortlaufender Topf — alle Termine des Laufs teilen ihn.
    case "entlastungsbetrag_45b":
      return "lauf";
    // §45a: Monatsbudget — nur Termine desselben Kalendermonats.
    case "umwandlung_45a":
      return datum.slice(0, 7);
    // §39/§42a: Jahresbudget — NICHT entschieden, siehe Dateikopf.
    case "ersatzpflege_39_42a":
      return datum.slice(0, 4);
    default:
      return `${budgetType}:${datum}`;
  }
}
