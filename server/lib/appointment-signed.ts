/**
 * Task #1119 — Server-seitige SQL-Spiegelung des geteilten Prädikats
 * `isAppointmentDocumentedAndSigned` (siehe `shared/domain/appointments.ts`).
 *
 * Ein Termin gilt als „dokumentiert & unterschrieben", wenn:
 *   - status = 'completed' UND
 *   - eine direkte Unterschrift (`signature_data`) vorliegt ODER
 *   - er mit einem unterschriebenen Leistungsnachweis
 *     (`monthly_service_records.status` in 'employee_signed'/'completed') verknüpft ist.
 *
 * WICHTIG: Diese SQL-Fragmente MÜSSEN exakt dem reinen TS-Prädikat in
 * `shared/domain/appointments.ts` entsprechen. Wird das eine geändert, ist das
 * andere in lockstep mitzuziehen, sonst driften Anzeige und Buchung auseinander.
 */
import { sql, type SQL } from "drizzle-orm";
import { appointments } from "@shared/schema";

const SIGNED_SR_EXISTS = sql`EXISTS (
  SELECT 1
  FROM service_record_appointments sra
  JOIN monthly_service_records msr ON msr.id = sra.service_record_id
  WHERE sra.appointment_id = ${appointments.id}
    AND msr.deleted_at IS NULL
    AND msr.status IN ('employee_signed', 'completed')
)`;

/**
 * Drizzle-Bedingung „dokumentiert & unterschrieben" — nutzbar in
 * `.where(and(...))` gegen die `appointments`-Tabelle.
 */
export function appointmentDocumentedAndSignedCondition(): SQL {
  return sql`(${appointments.status} = 'completed' AND (${appointments.signatureData} IS NOT NULL OR ${SIGNED_SR_EXISTS}))`;
}

/**
 * Drizzle-Bedingung „NICHT dokumentiert & unterschrieben" — alles, was in einem
 * abzuschließenden Monat eigentlich dokumentiert+unterschrieben sein müsste, es
 * aber nicht ist (= abgeleitetes Anzeige-Label „Nicht abgerechnet").
 */
export function appointmentNotDocumentedAndSignedCondition(): SQL {
  return sql`NOT ${appointmentDocumentedAndSignedCondition()}`;
}

/**
 * Drizzle-Bedingung „completed, aber unsigniert" — der Anteil der completed-Termine
 * ohne jegliche Unterschrift (weder direkt noch via Leistungsnachweis).
 */
export function appointmentCompletedButUnsignedCondition(): SQL {
  return sql`(${appointments.status} = 'completed' AND ${appointments.signatureData} IS NULL AND NOT ${SIGNED_SR_EXISTS})`;
}

/**
 * Roh-SQL-Fragment „dokumentiert & unterschrieben" für `db.execute`-Queries, die
 * mit einem Tabellen-Alias arbeiten (z.B. `FROM appointments a`).
 */
export function documentedAndSignedSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'completed' AND (${a}.signature_data IS NOT NULL OR EXISTS (
    SELECT 1
    FROM service_record_appointments sra
    JOIN monthly_service_records msr ON msr.id = sra.service_record_id
    WHERE sra.appointment_id = ${a}.id
      AND msr.deleted_at IS NULL
      AND msr.status IN ('employee_signed', 'completed')
  )))`;
}

/**
 * Roh-SQL-Fragment „completed, aber unsigniert" für `db.execute`-Queries, die mit
 * einem Tabellen-Alias arbeiten (z.B. `FROM appointments a`). Spiegelt
 * `appointmentCompletedButUnsignedCondition()` und MUSS mit dem reinen TS-Prädikat
 * in `shared/domain/appointments.ts` in lockstep bleiben.
 */
export function completedButUnsignedSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'completed' AND ${a}.signature_data IS NULL AND NOT EXISTS (
    SELECT 1
    FROM service_record_appointments sra
    JOIN monthly_service_records msr ON msr.id = sra.service_record_id
    WHERE sra.appointment_id = ${a}.id
      AND msr.deleted_at IS NULL
      AND msr.status IN ('employee_signed', 'completed')
  ))`;
}

/**
 * Service-Codes, die als bezahlte „Dienst-Minuten" der unsignierten Termine
 * gezählt werden (Stunden-basierte Leistungen). SSoT für die LATERAL-Subquery in
 * `unsignedServiceMinutesLateralRaw`.
 */
export const UNSIGNED_SERVICE_MINUTE_CODES = [
  "hauswirtschaft",
  "alltagsbegleitung",
  "erstberatung",
] as const;

/**
 * Roh-SQL-Fragment für die LATERAL-Subquery, die die bezahlten Dienst-Minuten
 * eines (unsignierten) Termins aus `appointment_services` aggregiert. Liefert
 * eine abgeleitete Tabelle mit Spalte `minutes` und dem übergebenen Result-Alias.
 *
 * Genutzt von beiden Endpoints in `server/routes/admin/lexware-export.ts`
 * (Warnung `/api/admin/hours-overview` und aufklappbare Liste
 * `/api/admin/hours-overview/unsigned-appointments`), damit die Minuten-Berechnung
 * nur EINE Quelle hat und nicht per Konvention auseinanderdriftet.
 *
 * @param apptAlias  Alias der `appointments`-Tabelle im äußeren Query (z.B. `a`).
 * @param resultAlias Alias der abgeleiteten Tabelle (z.B. `svc_minutes`).
 */
export function unsignedServiceMinutesLateralRaw(
  apptAlias: string,
  resultAlias: string,
): SQL {
  const a = sql.raw(apptAlias);
  const r = sql.raw(resultAlias);
  const codes = sql.join(
    UNSIGNED_SERVICE_MINUTE_CODES.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes)) as minutes
      FROM appointment_services asvc
      JOIN services s ON s.id = asvc.service_id
      WHERE asvc.appointment_id = ${a}.id
        AND s.unit_type = 'hours'
        AND s.code IN (${codes})
    ) ${r} ON true`;
}
