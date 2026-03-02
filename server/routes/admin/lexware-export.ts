import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users, employeeCompensationHistory } from "@shared/schema/users";
import { companySettings } from "@shared/schema/company";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq, isNull } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { getHolidays } from "@shared/utils/holidays";
import { parseLocalDate } from "@shared/utils/datetime";

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
  bruttoCents: number | null;
  uebertragVormonatCents: number | null;
  auszahlbarCents: number | null;
  uebertragNeuCents: number | null;
}

interface CompensationRates {
  hwCents: number;
  abCents: number;
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
    const date = parseLocalDate(holiday.date);
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

function calculateBruttoAndCarryover(
  hwHours: number,
  abHours: number,
  ebHours: number,
  sonstigesHours: number,
  feiertagHours: number,
  rates: CompensationRates,
  earningsLimitCents: number,
  carryoverCentsFromPrev: number
): { bruttoCents: number; auszahlbarCents: number; carryoverCents: number } {
  const hwCents = Math.round(hwHours * rates.hwCents);
  const abCents = Math.round(abHours * rates.abCents);
  const ebCents = Math.round(ebHours * rates.abCents);
  const sonstigesCents = Math.round(sonstigesHours * rates.hwCents);
  const feiertagCents = Math.round(feiertagHours * rates.hwCents);

  const bruttoCents = hwCents + abCents + ebCents + sonstigesCents + feiertagCents;

  const totalPayableCents = bruttoCents + carryoverCentsFromPrev;

  if (totalPayableCents <= earningsLimitCents) {
    return {
      bruttoCents,
      auszahlbarCents: totalPayableCents,
      carryoverCents: 0,
    };
  }

  return {
    bruttoCents,
    auszahlbarCents: earningsLimitCents,
    carryoverCents: totalPayableCents - earningsLimitCents,
  };
}

type MonthlyHoursMap = Record<number, Record<number, { hauswirtschaft: number; alltagsbegleitung: number; erstberatung: number; sonstiges: number }>>;

async function getMonthlyHoursBatch(
  employeeIds: number[],
  year: number,
  fromMonth: number,
  toMonth: number
): Promise<MonthlyHoursMap> {
  const startDate = `${year}-${String(fromMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(year, toMonth, 0).getDate();
  const endDate = `${year}-${String(toMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const result: MonthlyHoursMap = {};

  const appointmentHours = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM a.date::date) as month_num,
      CASE
        WHEN s.code = 'erstberatung' THEN 'erstberatung'
        WHEN s.lohnart_kategorie = 'alltagsbegleitung' THEN 'alltagsbegleitung'
        WHEN s.lohnart_kategorie = 'hauswirtschaft' THEN 'hauswirtschaft'
        ELSE 'sonstiges'
      END as category,
      SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes)) as minutes
    FROM appointments a
    JOIN appointment_services asvc ON asvc.appointment_id = a.id
    JOIN services s ON s.id = asvc.service_id
    WHERE a.status IN ('completed', 'documented')
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
      AND s.unit_type = 'hours'
    GROUP BY a.performed_by_employee_id, category, EXTRACT(MONTH FROM a.date::date)
  `);

  for (const row of appointmentHours.rows as any[]) {
    const empId = row.employee_id;
    const m = Number(row.month_num);
    if (!result[m]) result[m] = {};
    if (!result[m][empId]) result[m][empId] = { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, sonstiges: 0 };
    const minutes = Number(row.minutes) || 0;
    const category = row.category as string;
    if (category === "alltagsbegleitung") {
      result[m][empId].alltagsbegleitung += minutes;
    } else if (category === "hauswirtschaft") {
      result[m][empId].hauswirtschaft += minutes;
    } else if (category === "erstberatung") {
      result[m][empId].erstberatung += minutes;
    } else {
      result[m][empId].sonstiges += minutes;
    }
  }

  const timeEntries = await db.select({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
    entryDate: employeeTimeEntries.entryDate,
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

  for (const entry of timeEntries) {
    const empId = entry.userId;
    const m = parseLocalDate(entry.entryDate).getMonth() + 1;
    if (!result[m]) result[m] = {};
    if (!result[m][empId]) result[m][empId] = { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, sonstiges: 0 };
    if (entry.entryType !== "kundentermin" && entry.entryType !== "urlaub" && entry.entryType !== "krankheit" && entry.entryType !== "verfuegbar") {
      let minutes = entry.durationMinutes || 0;
      if (!minutes && entry.startTime && entry.endTime) {
        const [sh, sm] = entry.startTime.split(":").map(Number);
        const [eh, em] = entry.endTime.split(":").map(Number);
        minutes = (eh * 60 + em) - (sh * 60 + sm);
      }
      result[m][empId].sonstiges += minutes;
    }
  }

  return result;
}

router.get("/hours-overview", asyncHandler("Stundenübersicht konnte nicht geladen werden", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

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

  const [companySettingsRow] = await db.select({
    minijobEarningsLimitCents: companySettings.minijobEarningsLimitCents,
  }).from(companySettings).limit(1);

  const earningsLimitCents = companySettingsRow?.minijobEarningsLimitCents ?? 55600;

  const compensationRecords = await db.select({
    userId: employeeCompensationHistory.userId,
    hwCents: employeeCompensationHistory.hourlyRateHauswirtschaftCents,
    abCents: employeeCompensationHistory.hourlyRateAlltagsbegleitungCents,
  }).from(employeeCompensationHistory).where(
    and(
      inArray(employeeCompensationHistory.userId, employeeIds),
      isNull(employeeCompensationHistory.validTo)
    )
  );

  const ratesByEmployee: Record<number, CompensationRates> = {};
  for (const comp of compensationRecords) {
    ratesByEmployee[comp.userId] = {
      hwCents: comp.hwCents ?? 0,
      abCents: comp.abCents ?? 0,
    };
  }

  const minijobberIds = employees.filter(e => e.employmentType === "minijobber").map(e => e.id);
  const carryoverByEmployee: Record<number, number> = {};

  const allMonthsHours = await getMonthlyHoursBatch(employeeIds, year, 1, month);

  if (minijobberIds.length > 0) {
    for (let m = 1; m < month; m++) {
      const monthData = allMonthsHours[m] || {};
      
      for (const empId of minijobberIds) {
        const rates = ratesByEmployee[empId];
        if (!rates || (rates.hwCents === 0 && rates.abCents === 0)) continue;

        const hours = monthData[empId] || { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, sonstiges: 0 };
        const emp = employees.find(e => e.id === empId)!;
        const feiertage = calculateHolidayHours(year, m, emp.employmentType, emp.monthlyWorkHours);
        
        const prevCarryover = carryoverByEmployee[empId] || 0;
        const result = calculateBruttoAndCarryover(
          hours.hauswirtschaft / 60,
          hours.alltagsbegleitung / 60,
          hours.erstberatung / 60,
          hours.sonstiges / 60,
          feiertage,
          rates,
          earningsLimitCents,
          prevCarryover
        );
        carryoverByEmployee[empId] = result.carryoverCents;
      }
    }
  }

  const currentMonthHours = allMonthsHours[month] || {};

  const kmResult = await db.execute(sql`
    SELECT 
      performed_by_employee_id as employee_id,
      COALESCE(SUM(COALESCE(travel_kilometers, 0) + COALESCE(customer_kilometers, 0)), 0) as total_km
    FROM appointments
    WHERE status IN ('completed', 'documented')
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
    GROUP BY performed_by_employee_id
  `);

  const kmByEmployee: Record<number, number> = {};
  for (const row of kmResult.rows as any[]) {
    kmByEmployee[row.employee_id] = Number(row.total_km) || 0;
  }

  const timeEntries = await db.select({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
  }).from(employeeTimeEntries).where(
    and(
      inArray(employeeTimeEntries.userId, employeeIds),
      gte(employeeTimeEntries.entryDate, startDate),
      lte(employeeTimeEntries.entryDate, endDate)
    )
  );

  const vacationDays: Record<number, number> = {};
  const sickDays: Record<number, number> = {};

  for (const entry of timeEntries) {
    const empId = entry.userId;
    if (entry.entryType === "urlaub") {
      vacationDays[empId] = (vacationDays[empId] || 0) + 1;
    } else if (entry.entryType === "krankheit") {
      sickDays[empId] = (sickDays[empId] || 0) + 1;
    }
  }

  const rows: EmployeeSummaryRow[] = [];

  for (const emp of employees) {
    const hours = currentMonthHours[emp.id] || { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, sonstiges: 0 };

    const stundenHW = hours.hauswirtschaft / 60;
    const stundenAB = hours.alltagsbegleitung / 60;
    const stundenEB = hours.erstberatung / 60;
    const stundenSonstiges = hours.sonstiges / 60;
    const km = kmByEmployee[emp.id] || 0;
    const urlaub = vacationDays[emp.id] || 0;
    const krankheit = sickDays[emp.id] || 0;
    const feiertage = calculateHolidayHours(year, month, emp.employmentType, emp.monthlyWorkHours);

    let bruttoCents: number | null = null;
    let uebertragVormonatCents: number | null = null;
    let auszahlbarCents: number | null = null;
    let uebertragNeuCents: number | null = null;

    if (emp.employmentType === "minijobber") {
      const rates = ratesByEmployee[emp.id];
      if (rates && (rates.hwCents > 0 || rates.abCents > 0)) {
        const prevCarryoverCents = carryoverByEmployee[emp.id] || 0;
        uebertragVormonatCents = prevCarryoverCents;

        const result = calculateBruttoAndCarryover(
          stundenHW, stundenAB, stundenEB, stundenSonstiges, feiertage,
          rates, earningsLimitCents, prevCarryoverCents
        );
        bruttoCents = result.bruttoCents;
        auszahlbarCents = result.auszahlbarCents;
        uebertragNeuCents = result.carryoverCents;
      }
    }

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
        bruttoCents,
        uebertragVormonatCents,
        auszahlbarCents,
        uebertragNeuCents,
      });
    }
  }

  rows.sort((a, b) => a.nachname.localeCompare(b.nachname) || a.vorname.localeCompare(b.vorname));

  res.json({ rows, year, month, earningsLimitCents });
}));

export default router;
