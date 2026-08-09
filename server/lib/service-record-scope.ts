/**
 * Task #1896 — Server-seitige SQL-Spiegelung des geteilten Prädikats
 * `appointmentBelongsToEmployeeScope` (siehe
 * `shared/domain/service-record-scope.ts`).
 *
 * ERSETZT die private Funktion `employeeFilter` aus
 * `server/storage/service-records-storage.ts` (dort unbenannt und ohne
 * Begründung) sowie ihre wörtliche Inline-Dublette in
 * `getServiceRecordsOverview`.
 *
 * Die Regel ist STATUS-ABHÄNGIG und ausdrücklich NICHT flach
 * `assigned OR performed`:
 *   - `status = 'completed'` → nur `performed_by_employee_id`
 *   - sonst                  → nur `assigned_employee_id`
 *
 * Begründung, Herkunft der Weiche und die Abgrenzung zur Zuordnungs-SSoT
 * stehen vollständig im Kopf des geteilten Moduls — hier nicht doppelt.
 *
 * WICHTIG: Dieses Fragment MUSS exakt dem reinen TS-Prädikat entsprechen. Wird
 * das eine geändert, ist das andere in lockstep mitzuziehen — sonst zeigt die
 * Übersicht einen anderen Umfang als den Nachweis, den man daraus erstellen
 * kann. `tests/equality/service-record-scope-parity.test.ts` prüft die
 * Deckungsgleichheit über die volle Status-/NULL-Matrix an echten Zeilen.
 *
 * NULL-Sicherheit: `= NULL` ergibt NULL (nicht true), und NULL filtert in
 * `WHERE` wie `false`. Ein dokumentierter Termin ohne Erbringer bzw. ein
 * offener ohne Zuweisung fällt damit heraus — deckungsgleich mit dem `false`
 * des TS-Prädikats. `status` ist `NOT NULL`, die Fallunterscheidung selbst hat
 * also keine NULL-Falle.
 */
import { sql, type SQL } from "drizzle-orm";
import { appointments } from "@shared/schema";

/**
 * Drizzle-Bedingung „dieser Termin gehört dem Mitarbeiter" — nutzbar in
 * `.where(and(...))` und in `leftJoin(...)`-Bedingungen gegen die
 * `appointments`-Tabelle.
 */
export function employeeServiceRecordScopeCondition(employeeId: number): SQL {
  return sql`(CASE WHEN ${appointments.status} = 'completed'
    THEN ${appointments.performedByEmployeeId} = ${employeeId}
    ELSE ${appointments.assignedEmployeeId} = ${employeeId}
  END)`;
}
