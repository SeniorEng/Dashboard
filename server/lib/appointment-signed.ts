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
 * Drizzle-Bedingung „completed, aber unsigniert" — der Anteil der completed-Termine
 * ohne jegliche Unterschrift (weder direkt noch via Leistungsnachweis).
 *
 * Carve-out (Task #1586): Erstberatungen (`appointment_type = 'Erstberatung'`) werden
 * dokumentiert (status = 'completed'), bekommen aber NIE eine Unterschrift — es gibt
 * keinen Kunden, gegen den unterschrieben würde. Sie sind daher hier ausgeschlossen
 * und tauchen nie als „Unterschrift fehlt" auf. `appointment_type` ist `NOT NULL`,
 * daher ist `<> 'Erstberatung'` ohne NULL-Falle sicher. MUSS mit `completedButUnsignedSqlRaw`
 * in lockstep bleiben.
 */
export function appointmentCompletedButUnsignedCondition(): SQL {
  return sql`(${appointments.status} = 'completed' AND ${appointments.appointmentType} <> 'Erstberatung' AND ${appointments.signatureData} IS NULL AND NOT ${SIGNED_SR_EXISTS})`;
}

/**
 * Drizzle-Bedingung „dokumentiert" (Task #1496) — Arbeit erbracht, UNABHÄNGIG von
 * einer Unterschrift: status = 'completed'. SQL-Spiegel von `isAppointmentDocumented`
 * (`shared/domain/appointments.ts`); MUSS mit diesem reinen TS-Prädikat in lockstep
 * bleiben. Entscheidet über „Nicht abgerechnet"/Lohn — NICHT über die Kunden-/
 * Pflegekassen-Abrechnung (dafür `appointmentDocumentedAndSignedCondition`).
 */
export function appointmentDocumentedCondition(): SQL {
  return sql`(${appointments.status} = 'completed')`;
}

/**
 * Drizzle-Bedingung „NICHT dokumentiert" — alles, was in einem abzuschließenden
 * Monat eigentlich dokumentiert sein müsste, es aber nicht ist (= abgeleitetes
 * Anzeige-Label „Nicht abgerechnet", Task #1496 von der Unterschrift entkoppelt).
 */
export function appointmentNotDocumentedCondition(): SQL {
  return sql`NOT ${appointmentDocumentedCondition()}`;
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
 * Roh-SQL-Fragment „hat eine DIREKTE Unterschrift?" für `db.execute`-Queries mit
 * Tabellen-Alias (z.B. `FROM appointments a`).
 *
 * Das PRIMITIV, nicht das zusammengesetzte Prädikat: Es beantwortet nur die
 * Teilfrage `signature_data IS NOT NULL` — ohne `status`-Gate und ohne den
 * Leistungsnachweis-Zweig. Wer „dokumentiert & unterschrieben?" braucht, nimmt
 * `documentedAndSignedSqlRaw`; dieses Fragment ist ausschließlich für Leser
 * gedacht, die die drei Teilflags EINZELN brauchen und selbst komponieren —
 * heute die Abrechnungs-Pipeline (`assignAppointmentStage` in
 * `shared/domain/billing-pipeline.ts` setzt sie zur Stufen-Zuordnung zusammen).
 *
 * ERSETZT die rohe Inline-Bedingung `(a.signature_data IS NOT NULL)` in
 * `server/storage/billing/pipeline-reader.ts`. Sie war die letzte
 * `signature_data`-Prüfung außerhalb dieser Datei und brach den A3-Wächter
 * (`tests/architecture/ssot-imports.test.ts`) — die Spalte wurde nach Task #1874
 * eingeführt, ohne dass es ein Primitiv gab, das man hätte nutzen können.
 *
 * MUSS mit dem `signature_data`-Zweig in `documentedAndSignedSqlRaw` und dem
 * reinen TS-Prädikat in `shared/domain/appointments.ts` in lockstep bleiben:
 * bekommt „direkte Unterschrift" je einen Zusatz (etwa den Erstberatungs-
 * Carve-out aus Task #1586), gehört er hierher UND dorthin.
 */
export function hasDirectSignatureSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.signature_data IS NOT NULL)`;
}

/**
 * Roh-SQL-Fragment „dokumentiert" (Task #1496) für `db.execute`-Queries mit
 * Tabellen-Alias (z.B. `FROM appointments a`). Spiegelt `appointmentDocumentedCondition()`
 * bzw. das reine TS-Prädikat `isAppointmentDocumented` und MUSS mit ihm in lockstep
 * bleiben. Genutzt vom Lohn-/Lexware-Export (dokumentierte Arbeit ist zahlbar, auch
 * ohne Unterschrift).
 */
export function documentedSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'completed')`;
}

/**
 * Roh-SQL-Fragment „completed, aber unsigniert" für `db.execute`-Queries, die mit
 * einem Tabellen-Alias arbeiten (z.B. `FROM appointments a`). Spiegelt
 * `appointmentCompletedButUnsignedCondition()` und MUSS mit dem reinen TS-Prädikat
 * in `shared/domain/appointments.ts` in lockstep bleiben.
 *
 * Carve-out (Task #1586): Erstberatungen (`appointment_type = 'Erstberatung'`) sind
 * ausgeschlossen — sie werden dokumentiert, aber nie unterschrieben (kein Kunde).
 * `appointment_type` ist `NOT NULL`, daher ist `<> 'Erstberatung'` NULL-sicher. MUSS
 * mit `appointmentCompletedButUnsignedCondition()` in lockstep bleiben.
 */
export function completedButUnsignedSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'completed' AND ${a}.appointment_type <> 'Erstberatung' AND ${a}.signature_data IS NULL AND NOT EXISTS (
    SELECT 1
    FROM service_record_appointments sra
    JOIN monthly_service_records msr ON msr.id = sra.service_record_id
    WHERE sra.appointment_id = ${a}.id
      AND msr.deleted_at IS NULL
      AND msr.status IN ('employee_signed', 'completed')
  ))`;
}

/**
 * Task #1886 — Fachregel „Erstberatungen werden dem KUNDEN nicht abgerechnet" als
 * Roh-SQL-Prädikat für `db.execute`-Queries mit Tabellen-Alias (z. B.
 * `FROM appointments a`). Erstberatungs-Termine (`appointment_type = 'Erstberatung'`,
 * kundenlose Interessenten-Termine mit `customer_id = NULL`) sind Akquise: sie erzeugen
 * keine Kunden-/Kassen-Rechnung und keinen Leistungsnachweis. In KUNDENSEITIGEN
 * „abrechenbar/dokumentiert aber fehlt"-/Reconciliation-Audits dürfen sie daher NICHT als
 * Lücke erscheinen (sonst Fehlalarm). `appointment_type` ist `NOT NULL`, daher ist
 * `<> 'Erstberatung'` NULL-sicher.
 *
 * NUR für die KUNDENSEITE. Auf der MITARBEITER-Seite (Lohn/Stunden/km,
 * `server/storage/time-tracking/payroll-hours.ts`) zählt die Erstberatung VOLL — dort
 * NICHT verwenden. Siehe CLAUDE.md → Arbeitsregeln (zweiseitige Regel).
 */
export function notErstberatungSqlRaw(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`${a}.appointment_type <> 'Erstberatung'`;
}

/**
 * Task #1874 — Roh-SQL-Fragment „hat einen aktiven Leistungsnachweis mit dem
 * gegebenen Status" für `db.execute`-Queries mit Tabellen-Alias (z. B.
 * `FROM appointments a`). Der Pipeline-Reader liest damit getrennt, ob ein
 * Termin durch eine Kunden-Unterschrift (`completed`) oder nur durch eine
 * Mitarbeiter-Unterschrift (`employee_signed`) auf einem LN abgedeckt ist, und
 * entscheidet die Abrechenbarkeit über das geteilte Gate
 * `isServiceRecordSignedForBilling` (zahler-typ-abhängig). MUSS mit den
 * LN-Status-Werten in `shared/domain/billing-eligibility.ts` in lockstep bleiben.
 */
export function serviceRecordWithStatusExistsSqlRaw(
  alias: string,
  srStatus: "employee_signed" | "completed",
): SQL {
  const a = sql.raw(alias);
  const status = sql.raw(`'${srStatus}'`);
  return sql`EXISTS (
    SELECT 1
    FROM service_record_appointments sra
    JOIN monthly_service_records msr ON msr.id = sra.service_record_id
    WHERE sra.appointment_id = ${a}.id
      AND msr.deleted_at IS NULL
      AND msr.status = ${status}
  )`;
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
