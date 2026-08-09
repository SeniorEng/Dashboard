/**
 * Task #1896 — Single source of truth für die Frage: **Gehört dieser Termin dem
 * Mitarbeiter, für dessen Leistungsnachweis er gebündelt werden soll?**
 *
 * ERSETZT die private, unbenannte Regel `employeeFilter` in
 * `server/storage/service-records-storage.ts` und ihre wörtliche Inline-Dublette
 * in `getServiceRecordsOverview`. Beide formulierten dieselbe Regel zweimal;
 * eine davon war nicht als Regel erkennbar.
 *
 * ## Die Regel ist STATUS-ABHÄNGIG
 *
 *  - **dokumentiert** (`status === 'completed'`): der Termin gehört dem, der ihn
 *    GELEISTET hat (`performedByEmployeeId`). Nichts anderes.
 *  - **noch offen**: er gehört dem, dem er ZUGEWIESEN ist
 *    (`assignedEmployeeId`) — `performedByEmployeeId` ist zu diesem Zeitpunkt
 *    noch gar nicht gesetzt.
 *
 * **Ausdrücklich NICHT flach `assigned ODER performed`.** Das war die erste
 * Fassung dieses Moduls, und sie hatte genau das Loch, das #1896 schließen
 * soll: fällt `assigned = A` und `performed = B` auseinander, besaß A den
 * Nachweis (Treffer über `assigned`) und durfte ihn unterschreiben — obwohl B
 * geleistet hat. Das Dokument wies dann A aus, unterschrieben von A, geleistet
 * von B. Die Verengung der Unterschrift auf den Nachweis-Inhaber (Schritt 5)
 * hätte den Fehler nur verschoben und dabei B, dem einzig richtigen
 * Unterzeichner, die Unterschrift genommen.
 *
 * Mit der status-abhängigen Regel gilt: **Nachweis-Inhaber = Erbringer =
 * Unterzeichner.** Weiche von Alrik am 09.08.2026 entschieden.
 *
 * Verlustfrei ist das, weil `performedByEmployeeId` bei JEDER Dokumentation
 * gesetzt wird (`buildDocumentationUpdate`, `server/services/appointments.ts`)
 * und nur dokumentierte Termine je in einen Leistungsnachweis kommen.
 *
 * ## Warum das KEINE vierte Antwort auf dieselbe Frage ist
 *
 * Diese Funktion ist ein benannter Aufruf der bestehenden Zuordnungs-SSoT
 * `appointmentBelongsToEmployee` (`./appointment-attribution.ts`, Task #838) —
 * **mit `coverage = null`**. Genau das ist der fachliche Unterschied und der
 * einzige:
 *
 *  - Mit Coverage fällt die Zuordnungs-SSoT bei einem offenen, NICHT
 *    zugewiesenen Termin auf die Vertretungs-Kette des Kunden zurück
 *    (Primär-/Backup-/Backup2-Kraft). Für Lohn und Stunden ist das richtig —
 *    der Termin steht in der Eigensicht aller Vertreter.
 *  - Für den Leistungsnachweis wäre dieselbe Kette die **Stammkraft-Ausnahme**,
 *    die #1896 gerade entfernt. Ein Nachweis über einen Termin, den niemand
 *    nachweislich geleistet hat, ist genau das Dokument, das die GoBD-Regel
 *    verbietet.
 *
 * `coverage = null` schaltet die Kette ab; alles andere ist geteilt. Ändert
 * sich die Zuordnungs-Regel, ändert sie sich hier automatisch mit — es gibt
 * keine zweite Formel, die man nachziehen müsste.
 *
 * ## Der Fall „kein Mitarbeiterbezug" — bewusst KONSERVATIV
 *
 * Ein dokumentierter Termin ohne `performedByEmployeeId` und ein offener ohne
 * `assignedEmployeeId` gehören NIEMANDEM und dürfen in KEINEN
 * Leistungsnachweis. Das ist die vorsichtige Lesart: der Termin verschwindet
 * aus allen Mitarbeiter-Umfängen, statt bei allen aufzutauchen.
 *
 * Die Prod-Abfrage vom 08.08.2026
 * (`docs/p1-1896-performer-vs-assigned-exposure.sql`) hat gezeigt, dass es
 * solche Termine derzeit nicht gibt (`beide_null = 0`, `b_echt_verschieden =
 * 0`) — die Definition ist trotzdem nötig, weil KEIN DB-Zwang die Spalten
 * koppelt oder befüllt.
 *
 * ## SQL-Spiegel
 *
 * `employeeServiceRecordScopeCondition` in `server/lib/service-record-scope.ts`
 * ist die drizzle-Bedingung zu genau diesem Prädikat. Beide MÜSSEN in lockstep
 * bleiben; `tests/equality/service-record-scope-parity.test.ts` prüft das über
 * die volle Status-/NULL-Matrix gegen die Datenbank.
 */
import {
  appointmentBelongsToEmployee,
  type AppointmentAttributionInput,
} from "./appointment-attribution";

/**
 * Was die Regel braucht: der Status entscheidet, WELCHE der beiden
 * Mitarbeiter-Spalten zählt.
 */
export type ServiceRecordScopeAppointment = AppointmentAttributionInput;

/**
 * Gehört der Termin dem Mitarbeiter (für Leistungsnachweis-Zwecke)?
 *
 * Dokumentiert (`completed`) → nur `performedByEmployeeId`; sonst → nur
 * `assignedEmployeeId`. Ist die jeweils maßgebliche Spalte `null`, gehört der
 * Termin niemandem (siehe Datei-Kopf).
 *
 * `coverage = null` ist NICHT beiläufig: es schaltet die Kunden-Vertretungs-
 * Kette der Zuordnungs-SSoT ab, die für den Leistungsnachweis die entfernte
 * Stammkraft-Ausnahme wäre.
 */
export function appointmentBelongsToEmployeeScope(
  appt: ServiceRecordScopeAppointment,
  employeeId: number,
): boolean {
  return appointmentBelongsToEmployee(appt, null, employeeId);
}
