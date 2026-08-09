/**
 * Task #1896 — Single source of truth für die Frage: **Gehört dieser Termin dem
 * Mitarbeiter, für dessen Leistungsnachweis er gebündelt werden soll?**
 *
 * ERSETZT die private, unbenannte Regel `employeeFilter` in
 * `server/storage/service-records-storage.ts` und ihre wörtliche Inline-Dublette
 * in `getServiceRecordsOverview`. Beide formulierten dieselbe Regel zweimal;
 * eine davon war nicht als Regel erkennbar.
 *
 * ## Die Regel
 *
 * Der Termin gehört dem Mitarbeiter, wenn er ihm ZUGEWIESEN war
 * (`assignedEmployeeId`) ODER wenn er ihn tatsächlich GELEISTET hat
 * (`performedByEmployeeId`). Beide Spalten zählen, weil sie im Lauf eines
 * Termins nacheinander gefüllt werden: die Zuweisung bei der Planung, der
 * Erbringer bei der Dokumentation
 * (`server/services/appointments.ts` → `buildDocumentationUpdate`).
 *
 * **Warum diese Frage GoBD-relevant ist:** Der Leistungsnachweis weist einen
 * Erbringer aus und wird von einem Mitarbeiter unterschrieben. Fällt der Umfang
 * eines Nachweises weiter als die eigenen Termine, weist das Dokument Erbringer
 * A aus, während B unterschreibt. Diese Funktion ist die Grenze, an der das
 * verhindert wird.
 *
 * ## Der Fall „beide NULL" — bewusst KONSERVATIV
 *
 * Ein Termin ohne jeden Mitarbeiterbezug gehört NIEMANDEM und darf in KEINEN
 * Leistungsnachweis. Das ist die vorsichtige Lesart: er verschwindet damit aus
 * allen Mitarbeiter-Umfängen, statt bei allen aufzutauchen. Ein Nachweis über
 * einen Termin ohne belegbaren Erbringer wäre genau das Dokument, das die Regel
 * verhindern soll.
 *
 * Die Prod-Abfrage vom 08.08.2026
 * (`docs/p1-1896-performer-vs-assigned-exposure.sql`) hat gezeigt, dass es
 * solche Termine derzeit nicht gibt (`beide_null = 0`) — die Definition ist
 * trotzdem nötig, weil KEIN DB-Zwang die beiden Spalten koppelt.
 *
 * ## Abgrenzung zu `attributeAppointmentToEmployees`
 *
 * `shared/domain/appointment-attribution.ts` beantwortet eine ANDERE Frage:
 * „wessen ARBEITSZEIT ist das?" (Lohn/Stunden). Sie ist status-abhängig
 * (`completed` → nur `performedByEmployeeId`) und fällt bei nicht zugewiesenen
 * Terminen auf die Vertretungs-Kette des Kunden zurück (Primär/Backup/Backup2).
 * Genau dieser Kunden-Rückfall ist die Stammkraft-Ausweitung, die #1896
 * entfernt — die Funktion ist hier also KEIN Ersatz und darf es nicht werden.
 *
 * ## SQL-Spiegel
 *
 * `employeeServiceRecordScopeCondition` in `server/lib/service-record-scope.ts`
 * ist die drizzle-Bedingung zu genau diesem Prädikat. Beide MÜSSEN in lockstep
 * bleiben; `tests/equality/service-record-scope-parity.test.ts` prüft das gegen
 * die Datenbank.
 */

export interface ServiceRecordScopeAppointment {
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
}

/**
 * Gehört der Termin dem Mitarbeiter (für Leistungsnachweis-Zwecke)?
 *
 * `true`, wenn `employeeId` in `assignedEmployeeId` ODER
 * `performedByEmployeeId` steht. Sind beide `null`, ist die Antwort `false` —
 * für jeden Mitarbeiter (siehe „beide NULL" im Datei-Kopf).
 */
export function appointmentBelongsToEmployeeScope(
  appt: ServiceRecordScopeAppointment,
  employeeId: number,
): boolean {
  return (
    appt.assignedEmployeeId === employeeId ||
    appt.performedByEmployeeId === employeeId
  );
}
