/**
 * Legacy-Endpunkt `/admin/hours-overview` (frühere „Stundenübersicht").
 *
 * Task #1555 — Die Stunden-Aggregation lebt jetzt in der EINEN SSoT
 * `server/storage/time-tracking/payroll-hours.ts` (`getEmployeePayrollRows`).
 * Dieser Endpunkt ist ein dünner Wrapper, der ausschließlich diese SSoT liest
 * und die Zeilen auf das historische Antwort-Schema mappt — es gibt KEINE
 * zweite, parallele Berechnung mehr. Die neue Oberfläche
 * „Mitarbeiterabrechnung & Stundenkonto" nutzt `/admin/mitarbeiterabrechnung`;
 * dieser Endpunkt bleibt für Rückwärtskompatibilität (Tests) erhalten.
 *
 * KEIN Lexware-CSV/Personalnummer/Lohnart-Export.
 */
import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { requireWageDataAccess } from "../../middleware/auth";
import { completedButUnsignedSqlRaw, unsignedServiceMinutesLateralRaw } from "../../lib/appointment-signed";
import { getEmployeePayrollRows } from "../../storage/time-tracking/payroll-hours";

const router = Router();

// GET /hours-overview — Legacy-Stundenübersicht (liest die SSoT).
router.get("/hours-overview", requireWageDataAccess, asyncHandler("Stundenübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  const { rows, earningsLimitCents } = await getEmployeePayrollRows(year, month);

  const mapped = rows.map((r) => ({
    employeeId: r.employeeId,
    nachname: r.nachname,
    vorname: r.vorname,
    stundenHauswirtschaft: r.stundenHauswirtschaft,
    stundenAlltagsbegleitung: r.stundenAlltagsbegleitung,
    stundenErstberatung: r.stundenErstberatung,
    stundenAnfahrt: r.stundenAnfahrt,
    stundenSonstiges: r.stundenSonstiges,
    stundenFeiertage: r.stundenFeiertage,
    kilometer: r.kilometer,
    kilometerAnfahrt: r.kilometerAnfahrt,
    kilometerKunden: r.kilometerKunden,
    kilometerSonstige: r.kilometerSonstige,
    tageUrlaub: r.tageUrlaub,
    tageKrankheit: r.tageKrankheit,
    isEuRentner: r.isEuRentner,
    employmentType: r.employmentType,
    weeklyWorkDays: r.weeklyWorkDays,
    monthlyWorkHours: r.monthlyWorkHours,
    bruttoCents: r.minijob?.bruttoCents ?? null,
    uebertragVormonatCents: r.minijob?.uebertragVormonatCents ?? null,
    auszahlbarCents: r.minijob?.auszahlbarCents ?? null,
    uebertragNeuCents: r.minijob?.uebertragNeuCents ?? null,
    unsignedAppointmentCount: r.unsignedAppointmentCount,
    unsignedMinutes: r.unsignedMinutes,
  }));

  res.json({ rows: mapped, year, month, earningsLimitCents });
}));

interface UnsignedAppointmentRow {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  minutes: number;
}

// Liste der completed-aber-unsignierten Termine eines Mitarbeiters im gewählten
// Monat — Sprung-Ziel aus der Warnung „N Termine ohne Unterschrift". Nutzt
// dasselbe Prädikat (`completedButUnsignedSqlRaw`) wie die Warnzählung in der
// SSoT, damit Liste und Zähler konsistent sind.
router.get("/hours-overview/unsigned-appointments", requireWageDataAccess, asyncHandler("Nicht unterschriebene Termine konnten nicht geladen werden", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  const employeeId = parseInt(req.query.employeeId as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  if (isNaN(employeeId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Mitarbeiter-ID" });
    return;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const result = await db.execute(sql`
    SELECT
      a.id as id,
      a.date as date,
      a.scheduled_start as scheduled_start,
      c.name as customer_name,
      COALESCE(svc_minutes.minutes, 0) as minutes
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    ${unsignedServiceMinutesLateralRaw('a', 'svc_minutes')}
    WHERE ${completedButUnsignedSqlRaw('a')}
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ${employeeId}
    ORDER BY a.date ASC, a.scheduled_start ASC NULLS LAST
  `);

  const appointments: UnsignedAppointmentRow[] = (result.rows as any[]).map(row => ({
    id: Number(row.id),
    date: typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10),
    scheduledStart: row.scheduled_start ?? null,
    customerName: row.customer_name ?? "",
    minutes: Number(row.minutes) || 0,
  }));

  res.json({ appointments, year, month, employeeId });
}));

export default router;
