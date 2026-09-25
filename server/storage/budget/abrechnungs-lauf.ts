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
 *   · Gegen alle Töpfe wird NETTO gerechnet; USt entsteht nur auf der
 *     Privatrechnung und verbraucht nie Budget.
 *
 * Seit der Vorschau-Probelauf (`invoice-data.ts`, `probelaufNeubuchung`) die
 * echte Neubuchung fährt, setzt die Buchungs-Engine diese Regel für BEIDE Wege
 * um — Fenster je Topf inklusive (§45a Monat, §39 Kalenderjahr,
 * `consumption-engine.ts`). Was hier bleibt, ist die EINE Sache, die beide
 * Wege teilen müssen und die die Engine nicht kennt: die Reihenfolge.
 *
 * ERSETZT: die zufällige Reihenfolge im Erstellen und — mit dem Probelauf —
 * die eigene Nachbildung der Vorschau samt ihrer Topf-Fenster
 * (`fensterSchluessel`, von #193 eingeführt und im selben PR wieder
 * entfernt, als Alrik entschied, dass die Vorschau dieselbe Rechnung sein muss).
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
 * Hart gelöschte IDs fallen heraus. Soft-gelöschte BLEIBEN in der Reihenfolge
 * (kein `activeOnly()`) — das ist dieselbe Menge wie vor dieser Datei: das
 * Erstellen hat sie schon vorher nicht gefiltert, und ein Filter hier hätte
 * sein Verhalten geändert (Gate 2 zu #193, Notiz). Die Vorschau überspringt
 * sie ohnehin, weil sie für inaktive Termine kein Datum findet.
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
