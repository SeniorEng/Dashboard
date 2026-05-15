import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users, employeeCompensationHistory } from "@shared/schema/users";
import { companySettings } from "@shared/schema/company";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq, isNull } from "drizzle-orm";
import { employeeTimeEntriesRepo } from "../../repos";
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
  stundenAnfahrt: number;
  stundenSonstiges: number;
  stundenFeiertage: number;
  kilometer: number;
  kilometerAnfahrt: number;
  kilometerKunden: number;
  kilometerSonstige: number;
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
  sonstigesHours: number,
  feiertagHours: number,
  rates: CompensationRates,
  earningsLimitCents: number,
  carryoverCentsFromPrev: number
): { bruttoCents: number; auszahlbarCents: number; carryoverCents: number } {
  const hwCents = Math.round(hwHours * rates.hwCents);
  const abCents = Math.round(abHours * rates.abCents);
  const sonstigesCents = Math.round(sonstigesHours * rates.hwCents);
  const feiertagCents = Math.round(feiertagHours * rates.hwCents);

  const bruttoCents = hwCents + abCents + sonstigesCents + feiertagCents;

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

type MonthlyHoursBucket = {
  hauswirtschaft: number;
  alltagsbegleitung: number;
  erstberatung: number;
  anfahrt: number;
  sonstiges: number;
};

type MonthlyHoursMap = Record<number, Record<number, MonthlyHoursBucket>>;

function emptyBucket(): MonthlyHoursBucket {
  return { hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, anfahrt: 0, sonstiges: 0 };
}

// Time-entry types that count as paid working time (consistent with employee "Meine Zeiten" view).
// Excludes: urlaub, krankheit, pause, verfuegbar, blocker.
const PAID_MANUAL_ENTRY_TYPES = new Set(["bueroarbeit", "vertrieb", "sonstiges"]);

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

  const ensureBucket = (m: number, empId: number): MonthlyHoursBucket => {
    if (!result[m]) result[m] = {};
    if (!result[m][empId]) result[m][empId] = emptyBucket();
    return result[m][empId];
  };

  const appointmentHours = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM a.date::date) as month_num,
      s.code as service_code,
      SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes)) as minutes
    FROM appointments a
    JOIN appointment_services asvc ON asvc.appointment_id = a.id
    JOIN services s ON s.id = asvc.service_id
    WHERE a.status IN ('completed')
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
      AND s.unit_type = 'hours'
      AND s.code IN ('hauswirtschaft', 'alltagsbegleitung', 'erstberatung')
    GROUP BY a.performed_by_employee_id, s.code, EXTRACT(MONTH FROM a.date::date)
  `);

  for (const row of appointmentHours.rows as any[]) {
    const bucket = ensureBucket(Number(row.month_num), row.employee_id);
    const minutes = Number(row.minutes) || 0;
    const code = row.service_code as string;
    if (code === "alltagsbegleitung") {
      bucket.alltagsbegleitung += minutes;
    } else if (code === "hauswirtschaft") {
      bucket.hauswirtschaft += minutes;
    } else if (code === "erstberatung") {
      bucket.erstberatung += minutes;
    }
  }

  const travelMinutes = await db.execute(sql`
    SELECT 
      performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM date::date) as month_num,
      SUM(COALESCE(travel_minutes, 0)) as total_travel_minutes
    FROM appointments
    WHERE status IN ('completed')
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
      AND travel_minutes > 0
    GROUP BY performed_by_employee_id, EXTRACT(MONTH FROM date::date)
  `);

  for (const row of travelMinutes.rows as any[]) {
    const bucket = ensureBucket(Number(row.month_num), row.employee_id);
    bucket.anfahrt += Number(row.total_travel_minutes) || 0;
  }

  const timeEntries = await employeeTimeEntriesRepo.selectColumnsFrom({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
    entryDate: employeeTimeEntries.entryDate,
    durationMinutes: employeeTimeEntries.durationMinutes,
    startTime: employeeTimeEntries.startTime,
    endTime: employeeTimeEntries.endTime,
  }).where(
    and(
      inArray(employeeTimeEntries.userId, employeeIds),
      gte(employeeTimeEntries.entryDate, startDate),
      lte(employeeTimeEntries.entryDate, endDate),
      employeeTimeEntriesRepo.activeOnly()
    )
  );

  for (const entry of timeEntries) {
    if (!PAID_MANUAL_ENTRY_TYPES.has(entry.entryType)) continue;
    const bucket = ensureBucket(parseLocalDate(entry.entryDate).getMonth() + 1, entry.userId);
    let minutes = entry.durationMinutes || 0;
    if (!minutes && entry.startTime && entry.endTime) {
      const [sh, sm] = entry.startTime.split(":").map(Number);
      const [eh, em] = entry.endTime.split(":").map(Number);
      minutes = (eh * 60 + em) - (sh * 60 + sm);
    }
    bucket.sonstiges += minutes;
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

        const hours = monthData[empId] || emptyBucket();
        const emp = employees.find(e => e.id === empId)!;
        const feiertage = calculateHolidayHours(year, m, emp.employmentType, emp.monthlyWorkHours);

        // Pay Erstberatung + Anfahrt + Sonstiges manual entries together at HW rate
        // (preserves the previous payout where these were lumped into "sonstiges").
        const sonstigesForPayoutMinutes = hours.sonstiges + hours.erstberatung + hours.anfahrt;

        const prevCarryover = carryoverByEmployee[empId] || 0;
        const result = calculateBruttoAndCarryover(
          hours.hauswirtschaft / 60,
          hours.alltagsbegleitung / 60,
          sonstigesForPayoutMinutes / 60,
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
      COALESCE(SUM(COALESCE(travel_kilometers, 0)), 0) as travel_km,
      COALESCE(SUM(COALESCE(customer_kilometers, 0)), 0) as customer_km
    FROM appointments
    WHERE status IN ('completed')
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
    GROUP BY performed_by_employee_id
  `);

  const travelKmByEmployee: Record<number, number> = {};
  const customerKmByEmployee: Record<number, number> = {};
  for (const row of kmResult.rows as any[]) {
    travelKmByEmployee[row.employee_id] = Number(row.travel_km) || 0;
    customerKmByEmployee[row.employee_id] = Number(row.customer_km) || 0;
  }

  const timeEntries = await employeeTimeEntriesRepo.selectColumnsFrom({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
    kilometers: employeeTimeEntries.kilometers,
  }).where(
    and(
      inArray(employeeTimeEntries.userId, employeeIds),
      gte(employeeTimeEntries.entryDate, startDate),
      lte(employeeTimeEntries.entryDate, endDate),
      employeeTimeEntriesRepo.activeOnly()
    )
  );

  const vacationDays: Record<number, number> = {};
  const sickDays: Record<number, number> = {};
  const timeEntryKmByEmployee: Record<number, number> = {};

  for (const entry of timeEntries) {
    const empId = entry.userId;
    if (entry.entryType === "urlaub") {
      vacationDays[empId] = (vacationDays[empId] || 0) + 1;
    } else if (entry.entryType === "krankheit") {
      sickDays[empId] = (sickDays[empId] || 0) + 1;
    }
    // Sum km from any manual entry (matches "Sonstige Fahrten" in employee view)
    timeEntryKmByEmployee[empId] = (timeEntryKmByEmployee[empId] || 0) + (entry.kilometers || 0);
  }

  const rows: EmployeeSummaryRow[] = [];

  for (const emp of employees) {
    const hours = currentMonthHours[emp.id] || emptyBucket();

    const stundenHW = hours.hauswirtschaft / 60;
    const stundenAB = hours.alltagsbegleitung / 60;
    const stundenErstberatung = hours.erstberatung / 60;
    const stundenAnfahrt = hours.anfahrt / 60;
    const stundenSonstiges = hours.sonstiges / 60;
    const kmAnfahrt = travelKmByEmployee[emp.id] || 0;
    const kmKunden = customerKmByEmployee[emp.id] || 0;
    const kmSonstige = timeEntryKmByEmployee[emp.id] || 0;
    const km = kmAnfahrt + kmKunden + kmSonstige;
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

        // Erstberatung + Anfahrt + Sonstiges paid together at HW rate (preserves prior payout amounts).
        const sonstigesForPayout = stundenSonstiges + stundenErstberatung + stundenAnfahrt;
        const result = calculateBruttoAndCarryover(
          stundenHW, stundenAB, sonstigesForPayout, feiertage,
          rates, earningsLimitCents, prevCarryoverCents
        );
        bruttoCents = result.bruttoCents;
        auszahlbarCents = result.auszahlbarCents;
        uebertragNeuCents = result.carryoverCents;
      }
    }

    if (
      stundenHW > 0 || stundenAB > 0 || stundenErstberatung > 0 || stundenAnfahrt > 0 ||
      stundenSonstiges > 0 || km > 0 || urlaub > 0 || krankheit > 0 || feiertage > 0
    ) {
      rows.push({
        employeeId: emp.id,
        nachname: emp.nachname || "",
        vorname: emp.vorname || "",
        stundenHauswirtschaft: Math.round(stundenHW * 100) / 100,
        stundenAlltagsbegleitung: Math.round(stundenAB * 100) / 100,
        stundenErstberatung: Math.round(stundenErstberatung * 100) / 100,
        stundenAnfahrt: Math.round(stundenAnfahrt * 100) / 100,
        stundenSonstiges: Math.round(stundenSonstiges * 100) / 100,
        stundenFeiertage: feiertage,
        kilometer: Math.round(km * 10) / 10,
        kilometerAnfahrt: Math.round(kmAnfahrt * 10) / 10,
        kilometerKunden: Math.round(kmKunden * 10) / 10,
        kilometerSonstige: Math.round(kmSonstige * 10) / 10,
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
