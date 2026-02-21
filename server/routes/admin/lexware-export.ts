import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users } from "@shared/schema/users";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";

const router = Router();

interface EmployeeSummaryRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenSonstiges: number;
  kilometer: number;
  tageUrlaub: number;
  tageKrankheit: number;
}

router.get("/hours-overview", asyncHandler("Stundenübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(year, month, 0).toISOString().split("T")[0];

  const employees = await db.select({
    id: users.id,
    vorname: users.vorname,
    nachname: users.nachname,
  }).from(users).where(eq(users.isActive, true));

  if (employees.length === 0) {
    res.json({ rows: [], year, month });
    return;
  }

  const employeeIds = employees.map(e => e.id);

  const appointmentServices = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) as minutes,
      s.lohnart_kategorie,
      s.code
    FROM appointments a
    JOIN appointment_services asvc ON asvc.appointment_id = a.id
    JOIN services s ON s.id = asvc.service_id
    WHERE a.status = 'completed'
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${employeeIds})
      AND s.code NOT IN ('travel_km', 'customer_km')
  `);

  const hoursByEmployee: Record<number, { alltagsbegleitung: number; hauswirtschaft: number; sonstiges: number }> = {};

  for (const row of appointmentServices.rows as any[]) {
    const empId = row.employee_id;
    if (!hoursByEmployee[empId]) {
      hoursByEmployee[empId] = { alltagsbegleitung: 0, hauswirtschaft: 0, sonstiges: 0 };
    }
    if (row.lohnart_kategorie === "alltagsbegleitung") {
      hoursByEmployee[empId].alltagsbegleitung += Number(row.minutes) || 0;
    } else if (row.lohnart_kategorie === "hauswirtschaft") {
      hoursByEmployee[empId].hauswirtschaft += Number(row.minutes) || 0;
    } else {
      hoursByEmployee[empId].sonstiges += Number(row.minutes) || 0;
    }
  }

  const kmResult = await db.execute(sql`
    SELECT 
      performed_by_employee_id as employee_id,
      COALESCE(SUM(COALESCE(travel_kilometers, 0) + COALESCE(customer_kilometers, 0)), 0) as total_km
    FROM appointments
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id = ANY(${employeeIds})
    GROUP BY performed_by_employee_id
  `);

  const kmByEmployee: Record<number, number> = {};
  for (const row of kmResult.rows as any[]) {
    kmByEmployee[row.employee_id] = Number(row.total_km) || 0;
  }

  const timeEntries = await db.select({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
    durationMinutes: employeeTimeEntries.durationMinutes,
    startTime: employeeTimeEntries.startTime,
    endTime: employeeTimeEntries.endTime,
  }).from(employeeTimeEntries).where(
    and(
      inArray(employeeTimeEntries.userId, employeeIds),
      gte(employeeTimeEntries.entryDate, startDate),
      lte(employeeTimeEntries.entryDate, endDate)
    )
  );

  const nonClientMinutes: Record<number, number> = {};
  const vacationDays: Record<number, number> = {};
  const sickDays: Record<number, number> = {};

  for (const entry of timeEntries) {
    const empId = entry.userId;

    if (entry.entryType === "urlaub") {
      vacationDays[empId] = (vacationDays[empId] || 0) + 1;
    } else if (entry.entryType === "krankheit") {
      sickDays[empId] = (sickDays[empId] || 0) + 1;
    } else if (entry.entryType !== "kundentermin") {
      let minutes = entry.durationMinutes || 0;
      if (!minutes && entry.startTime && entry.endTime) {
        const [sh, sm] = entry.startTime.split(":").map(Number);
        const [eh, em] = entry.endTime.split(":").map(Number);
        minutes = (eh * 60 + em) - (sh * 60 + sm);
      }
      nonClientMinutes[empId] = (nonClientMinutes[empId] || 0) + minutes;
    }
  }

  const rows: EmployeeSummaryRow[] = [];

  for (const emp of employees) {
    const empHours = hoursByEmployee[emp.id] || { alltagsbegleitung: 0, hauswirtschaft: 0, sonstiges: 0 };
    const ncMinutes = nonClientMinutes[emp.id] || 0;

    const stundenHW = (empHours.hauswirtschaft + ncMinutes) / 60;
    const stundenAB = empHours.alltagsbegleitung / 60;
    const stundenSonstiges = empHours.sonstiges / 60;
    const km = kmByEmployee[emp.id] || 0;
    const urlaub = vacationDays[emp.id] || 0;
    const krankheit = sickDays[emp.id] || 0;

    if (stundenHW > 0 || stundenAB > 0 || stundenSonstiges > 0 || km > 0 || urlaub > 0 || krankheit > 0) {
      rows.push({
        employeeId: emp.id,
        nachname: emp.nachname,
        vorname: emp.vorname,
        stundenHauswirtschaft: Math.round(stundenHW * 100) / 100,
        stundenAlltagsbegleitung: Math.round(stundenAB * 100) / 100,
        stundenSonstiges: Math.round(stundenSonstiges * 100) / 100,
        kilometer: km,
        tageUrlaub: urlaub,
        tageKrankheit: krankheit,
      });
    }
  }

  rows.sort((a, b) => a.nachname.localeCompare(b.nachname) || a.vorname.localeCompare(b.vorname));

  res.json({ rows, year, month });
}));

export default router;
