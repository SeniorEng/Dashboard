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
 * WICHTIG: Dieses Fragment MUSS exakt dem reinen TS-Prädikat entsprechen. Wird
 * das eine geändert, ist das andere in lockstep mitzuziehen — sonst zeigt die
 * Übersicht einen anderen Umfang als der Nachweis, den man daraus erstellen
 * kann. `tests/equality/service-record-scope-parity.test.ts` prüft die
 * Deckungsgleichheit gegen echte Zeilen.
 *
 * NULL-Sicherheit: `=` gegen NULL ergibt NULL (nicht true), das `OR` damit
 * ebenfalls NULL, und NULL filtert in `WHERE` wie `false`. Der Fall „beide
 * Spalten NULL" fällt also heraus — deckungsgleich mit dem `false` des
 * TS-Prädikats.
 */
import { sql, type SQL } from "drizzle-orm";
import { appointments } from "@shared/schema";

/**
 * Drizzle-Bedingung „dieser Termin gehört dem Mitarbeiter" — nutzbar in
 * `.where(and(...))` und in `leftJoin(...)`-Bedingungen gegen die
 * `appointments`-Tabelle.
 */
export function employeeServiceRecordScopeCondition(employeeId: number): SQL {
  return sql`(${appointments.assignedEmployeeId} = ${employeeId} OR ${appointments.performedByEmployeeId} = ${employeeId})`;
}
