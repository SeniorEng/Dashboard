import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users } from "@shared/schema/users";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { getHolidays } from "@shared/utils/holidays";

const router = Router();

interface EmployeeSummaryRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenErstberatung: number;
  stundenSonstiges: number;
  stundenFeiertage: number;
  kilometer: number;
  tageUrlaub: number;
  tageKrankheit: number;
  isEuRentner: boolean;
  employmentType: string;
  weeklyWorkDays: number;
  monthlyWorkHours: number | null;
}

function calculateHolidayHours(
  year: number,
  month: number,
  employmentType: string,
  monthlyWorkHours: number | null
): number {
  const holidays = getHolidays(year);
  const monthStr = String(month).padStart(2, "0");
  const monthHolidays = holidays.filter(h => h.date.startsWith(`${year}-${monthStr}`));

  let totalHours = 0;

  for (const holiday of monthHolidays) {
    const date = new Date(holiday.date);
    const dayOfWeek = date.getDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    if (employmentType === "minijobber") {
      if (dayOfWeek === 1 || dayOfWeek === 2) {
        totalHours += 2.5;
      }
    } else {
      if (monthlyWorkHours && monthlyWorkHours > 0) {
        const dailyHours = monthlyWorkHours / 21.7;
        totalHours += Math.round(dailyHours * 100) / 100;
      }
    }
  }

  return Math.round(totalHours * 100) / 100;
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
    isEuRentner: users.isEuRentner,
    employmentType: users.employmentType,
    weeklyWorkDays: users.weeklyWorkDays,
    monthlyWorkHours: users.monthlyWorkHours,
  }).from(users).where(eq(users.isActive, true));

  if (employees.length === 0) {
    res.json({ rows: [], year, month });
    return;
  }

  const employeeIds = employees.map(e => e.id);
  const employeeIdArray = sql`${sql.raw(employeeIds.join(','))}`;

  const appointmentHours = await db.execute(sql`
    SELECT 
      performed_by_employee_id as employee_id,
      service_type,
      SUM(EXTRACT(EPOCH FROM (actual_end::time - actual_start::time)) / 60) as minutes
    FROM appointments
    WHERE status = 'completed'
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id IN (${employeeIdArray})
      AND actual_start IS NOT NULL
      AND actual_end IS NOT NULL
    GROUP BY performed_by_employee_id, service_type
  `);

  const hoursByEmployee: Record<number, { alltagsbegleitung: number; hauswirtschaft: number; erstberatung: number; sonstiges: number }> = {};

  for (const row of appointmentHours.rows as any[]) {
    const empId = row.employee_id;
    if (!hoursByEmployee[empId]) {
      hoursByEmployee[empId] = { alltagsbegleitung: 0, hauswirtschaft: 0, erstberatung: 0, sonstiges: 0 };
    }
    const minutes = Number(row.minutes) || 0;
    if (row.service_type === "alltagsbegleitung") {
      hoursByEmployee[empId].alltagsbegleitung += minutes;
    } else if (row.service_type === "hauswirtschaft") {
      hoursByEmployee[empId].hauswirtschaft += minutes;
    } else if (row.service_type === "erstberatung") {
      hoursByEmployee[empId].erstberatung += minutes;
    } else {
      hoursByEmployee[empId].sonstiges += minutes;
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
      AND performed_by_employee_id IN (${employeeIdArray})
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
    const empHours = hoursByEmployee[emp.id] || { alltagsbegleitung: 0, hauswirtschaft: 0, erstberatung: 0, sonstiges: 0 };
    const ncMinutes = nonClientMinutes[emp.id] || 0;

    const stundenHW = empHours.hauswirtschaft / 60;
    const stundenAB = empHours.alltagsbegleitung / 60;
    const stundenEB = empHours.erstberatung / 60;
    const stundenSonstiges = (empHours.sonstiges + ncMinutes) / 60;
    const km = kmByEmployee[emp.id] || 0;
    const urlaub = vacationDays[emp.id] || 0;
    const krankheit = sickDays[emp.id] || 0;
    const feiertage = calculateHolidayHours(year, month, emp.employmentType, emp.monthlyWorkHours);

    if (stundenHW > 0 || stundenAB > 0 || stundenEB > 0 || stundenSonstiges > 0 || km > 0 || urlaub > 0 || krankheit > 0 || feiertage > 0) {
      rows.push({
        employeeId: emp.id,
        nachname: emp.nachname || "",
        vorname: emp.vorname || "",
        stundenHauswirtschaft: Math.round(stundenHW * 100) / 100,
        stundenAlltagsbegleitung: Math.round(stundenAB * 100) / 100,
        stundenErstberatung: Math.round(stundenEB * 100) / 100,
        stundenSonstiges: Math.round(stundenSonstiges * 100) / 100,
        stundenFeiertage: feiertage,
        kilometer: km,
        tageUrlaub: urlaub,
        tageKrankheit: krankheit,
        isEuRentner: emp.isEuRentner,
        employmentType: emp.employmentType,
        weeklyWorkDays: emp.weeklyWorkDays,
        monthlyWorkHours: emp.monthlyWorkHours,
      });
    }
  }

  rows.sort((a, b) => a.nachname.localeCompare(b.nachname) || a.vorname.localeCompare(b.vorname));

  res.json({ rows, year, month });
}));

export default router;
