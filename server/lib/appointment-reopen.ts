/**
 * SSoT für „einen dokumentierten Termin zur Re-Dokumentation zurückgeben".
 *
 * ERSETZT die zuvor NUR in `POST /api/appointments/:id/reopen` inline stehende
 * Logik. Sie hat jetzt DREI Aufrufer, die dieselbe fachliche Frage stellen:
 *
 *   1. `POST /api/appointments/:id/reopen` — der Mitarbeiter korrigiert einen
 *      noch nicht in einen Leistungsnachweis eingegangenen Termin.
 *   2. `DELETE /api/service-records/:id` — der Korrekturweg für einen bereits
 *      unterschriebenen Leistungsnachweis: der LN wird soft-gelöscht und JEDER
 *      seiner Termine kommt zur Re-Dokumentation zurück.
 *   3. `POST /api/admin/revoke-signature/appointment/:id` — das Büro storniert
 *      die Unterschrift eines Termins (Task #70-FINDING). Dieser Pfad machte
 *      denselben halben Weg wie früher (2) und ließ die Budget-Buchung stehen —
 *      eine stille UNTERbuchung, weil der Dokumentations-Pfad beim erneuten
 *      Abschluss eine vorhandene, nicht-stornierte Buchung übernimmt statt neu
 *      zu buchen.
 *
 * Vorher machte (2) nur den halben Weg — `status = 'documenting'` und sonst
 * nichts. Das ließ zwei Reste stehen:
 *
 *   - **Budget-Buchung.** Der alte Verbrauch blieb gebucht. Wird der Termin
 *     anschließend nach OBEN korrigiert (mehr Stunden/km), bucht der erneute
 *     Abschluss zusätzlich — der Topf trägt dann alt + neu.
 *   - **System-Signatur (Task #876).** Trägt der Termin ein `signature_data`
 *     aus dem Budget-Backfill (`markAppointmentSystemSigned`), gilt er über
 *     `appointmentDocumentedAndSignedCondition()` weiterhin als „unterschrieben",
 *     obwohl nie ein Mensch unterschrieben hat — und `SIGNATURE_LOCKED` in
 *     `PATCH /:id` verhindert zusätzlich, dass die Signatur je erneuert wird.
 *
 * Beide Reste verschwinden, sobald beide Pfade dieselbe Funktion rufen.
 *
 * WICHTIG — kein Lock-Check hier drin. Ob ein gesperrter Termin (auf
 * unterschriebenem LN) angefasst werden darf, ist eine Frage des Aufrufers:
 * `reopen` verbietet es (409 `APPOINTMENT_LOCKED`), der LN-Korrekturweg erlaubt
 * es bewusst — dort ist das Aufheben der Sperre ja gerade der Zweck, und der LN
 * wird in derselben Transaktion soft-gelöscht. Ein Lock-Check an dieser Stelle
 * würde den zweiten Aufrufer unmöglich machen; er gehört an die Route.
 *
 * Muss INNERHALB einer Transaktion laufen, damit Reverse, Signatur-Löschung und
 * Statuswechsel gemeinsam gelten oder gemeinsam zurückgerollt werden.
 */
import { storage } from "../storage";
import { budgetStorage } from "../storage/budget-storage";
import type { Appointment } from "@shared/schema";
import type { Tx } from "./db";

/** Was der Reopen tatsächlich bewirkt hat — Grundlage des Audit-Eintrags. */
export interface AppointmentReopenFacts {
  appointmentId: number;
  /** Status VOR dem Reopen — macht `completed → documenting` im Audit sichtbar. */
  previousStatus: string;
  /** Anzahl zurückgedrehter Budget-Buchungen. */
  reversedTransactions: number;
  /**
   * Trug der Termin eine eigene `signature_data`, die hier geleert wurde?
   * Im Normalfall `false` — die menschlichen Unterschriften liegen am LN, nicht
   * am Termin. `true` heißt praktisch immer: System-Signatur aus dem Backfill.
   */
  clearedDirectSignature: boolean;
  /** Die zurückgesetzte Zeile — spart dem Aufrufer ein erneutes Laden. */
  appointment: Appointment;
}

/**
 * Dreht die Dokumentation eines Termins zurück: Budget-Buchungen reversen,
 * Holds freigeben, eigene Signatur leeren, Status auf `documenting`.
 *
 * Die Dokumentationsdaten selbst (Ist-Zeiten, km, Notizen, Leistungen) bleiben
 * ABSICHTLICH unangetastet — genau sie sind die Grundlage der Korrektur.
 */
export async function reopenAppointmentForRedocumentation(
  appointment: { id: number; status: string; signatureData: string | null },
  actorUserId: number,
  txClient: Tx,
): Promise<AppointmentReopenFacts> {
  // `txClient` MUSS mit — sonst liest der Aufruf über den globalen Pool an der
  // Transaktion vorbei. Das Inline-Original hatte denselben Fehler; beim Umzug
  // in die SSoT wird er geschlossen statt geerbt. Folgen sonst: eine Consumption,
  // die derselbe Aufrufer vorher in DIESER Tx geschrieben hat, fehlt im
  // Reverse-Set, und pro Termin wird eine zweite Pool-Verbindung gezogen,
  // während die Transaktion bereits eine hält.
  const transactions = await budgetStorage.getTransactionsByAppointmentId(appointment.id, txClient);
  // `getTransactionsByAppointmentId` liefert ALLE Consumptions des Termins, auch
  // bereits stornierte (z.B. nach einem km-Rebook). Gezählt wird deshalb das
  // tatsächliche Ergebnis, nicht die Eingangsmenge — sonst überzeichnet der
  // Audit-Eintrag die Zahl der Rückbuchungen.
  let reversedTransactions = 0;
  for (const tx of transactions) {
    const outcome = await budgetStorage.reverseBudgetTransactionWithOutcome(tx.id, actorUserId, txClient);
    if (outcome.status === "created") reversedTransactions += 1;
  }

  // Task #875 (gated) — beim Reopen lingering Holds freigeben; die Re-Doku legt
  // beim erneuten Abschluss frische Buchungen an. Flag aus = No-op.
  if (budgetStorage.hardHoldsEnabled()) {
    await budgetStorage.releaseHolds(appointment.id, actorUserId, txClient);
  }

  const updated = await storage.updateAppointment(appointment.id, {
    status: "documenting",
    signatureData: null,
    signatureHash: null,
    signedAt: null,
    signedByUserId: null,
  }, txClient);

  if (!updated) {
    throw new Error(`Termin ${appointment.id} konnte nicht zurückgesetzt werden`);
  }

  return {
    appointmentId: appointment.id,
    previousStatus: appointment.status,
    reversedTransactions,
    clearedDirectSignature: !!appointment.signatureData,
    appointment: updated,
  };
}
