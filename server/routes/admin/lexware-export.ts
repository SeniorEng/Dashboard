import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users } from "@shared/schema/users";
import { companySettings } from "@shared/schema/company";
import { roleWageRates } from "@shared/schema/contracts";
import { services } from "@shared/schema/services";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq, isNull } from "drizzle-orm";
import { employeeTimeEntriesRepo } from "../../repos";
import { asyncHandler } from "../../lib/errors";
import { getHolidays } from "@shared/utils/holidays";
import { parseLocalDate } from "@shared/utils/datetime";
import { documentedSqlRaw, completedButUnsignedSqlRaw, unsignedServiceMinutesLateralRaw } from "../../lib/appointment-signed";
import { resolveWageFor, wageRoleForUserFlags, type WageRole, type VersionedWageRow } from "@shared/domain/pricing/wage-for";
import { resolvedWageCentsSql, wageRoleSql } from "../../storage/pricing/wage-for-sql";
import { isTeamLead } from "../../lib/team-lead";

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
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
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

/**
 * Task #1503: Die Lohn-Summen pro Lohn-Komponente werden bereits PRO LEISTUNGS-
 * DATUM über die `wageFor`-SSoT aufgelöst (SQL-Spiegel `resolvedWageCentsSql`)
 * und hier nur noch addiert — KEINE eigene „Stunden × ein Monats-Satz"-Mathematik
 * mehr (driftete gegen Wirtschaftlichkeit/Statistik bei unterjährigem
 * Satzwechsel). `otherWageCents` bündelt Erstberatung + Anfahrt + Sonstiges (alle
 * zum HW-Satz, wie zuvor), `feiertagCents` die Feiertagsstunden zum HW-Satz.
 */
function calculateBruttoAndCarryover(
  hwWageCents: number,
  abWageCents: number,
  otherWageCents: number,
  feiertagCents: number,
  earningsLimitCents: number,
  carryoverCentsFromPrev: number
): { bruttoCents: number; auszahlbarCents: number; carryoverCents: number } {
  const bruttoCents = hwWageCents + abWageCents + otherWageCents + feiertagCents;

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
  // Task #1503: pro Leistungsdatum über `wageFor` aufgelöste Lohn-Summen
  // (Integer-Cents). hw/ab = Termin-Stunden zum eigenen Rollen-Satz;
  // otherWageCents = Erstberatung + Anfahrt + Sonstiges, alle zum HW-Satz.
  hwWageCents: number;
  abWageCents: number;
  otherWageCents: number;
};

type MonthlyHoursMap = Record<number, Record<number, MonthlyHoursBucket>>;

function emptyBucket(): MonthlyHoursBucket {
  return {
    hauswirtschaft: 0, alltagsbegleitung: 0, erstberatung: 0, anfahrt: 0, sonstiges: 0,
    hwWageCents: 0, abWageCents: 0, otherWageCents: 0,
  };
}

// Time-entry types that count as paid working time (consistent with employee "Meine Zeiten" view).
// Excludes: urlaub, krankheit, pause, verfuegbar, blocker.
const PAID_MANUAL_ENTRY_TYPES = new Set(["bueroarbeit", "vertrieb", "sonstiges"]);

async function getMonthlyHoursBatch(
  employeeIds: number[],
  year: number,
  fromMonth: number,
  toMonth: number,
  roleByEmployeeId: Record<number, WageRole>,
  resolveHwRateAt: (role: WageRole, dateISO: string) => number,
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

  // Task #1503: Lohn-Summe je Zeile PRO Termin-Datum über `wageFor` (SQL-Spiegel)
  // — HW/AB zum eigenen Rollen-Satz, Erstberatung (wie zuvor) zum HW-Satz. Die
  // ROUND-pro-Zeile-dann-SUM-Reihenfolge ist deckungsgleich mit Wirtschaftlich-
  // keit/Statistik (`revenue.ts`/`performance.ts`), damit Anzeige === Export.
  const hwRate = resolvedWageCentsSql(wageRoleSql("u"), "s", sql`a.date::date`);
  const hwRateForOther = resolvedWageCentsSql(wageRoleSql("u"), "hw", sql`a.date::date`);
  const appointmentHours = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM a.date::date) as month_num,
      s.code as service_code,
      SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes)) as minutes,
      SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
        CASE WHEN s.code IN ('hauswirtschaft', 'alltagsbegleitung') THEN ${hwRate}
             ELSE ${hwRateForOther} END
      )) as wage_cents
    FROM appointments a
    JOIN appointment_services asvc ON asvc.appointment_id = a.id
    JOIN services s ON s.id = asvc.service_id
    JOIN users u ON u.id = a.performed_by_employee_id
    CROSS JOIN (SELECT id, employee_rate_cents FROM services WHERE code = 'hauswirtschaft' LIMIT 1) hw
    WHERE ${documentedSqlRaw('a')}
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
    const wageCents = Number(row.wage_cents) || 0;
    const code = row.service_code as string;
    if (code === "alltagsbegleitung") {
      bucket.alltagsbegleitung += minutes;
      bucket.abWageCents += wageCents;
    } else if (code === "hauswirtschaft") {
      bucket.hauswirtschaft += minutes;
      bucket.hwWageCents += wageCents;
    } else if (code === "erstberatung") {
      bucket.erstberatung += minutes;
      bucket.otherWageCents += wageCents;
    }
  }

  const travelMinutes = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM a.date::date) as month_num,
      SUM(COALESCE(a.travel_minutes, 0)) as total_travel_minutes,
      SUM(ROUND(COALESCE(a.travel_minutes, 0) / 60.0 * ${hwRateForOther})) as travel_wage_cents
    FROM appointments a
    JOIN users u ON u.id = a.performed_by_employee_id
    CROSS JOIN (SELECT id, employee_rate_cents FROM services WHERE code = 'hauswirtschaft' LIMIT 1) hw
    WHERE ${documentedSqlRaw('a')}
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
      AND a.travel_minutes > 0
    GROUP BY a.performed_by_employee_id, EXTRACT(MONTH FROM a.date::date)
  `);

  for (const row of travelMinutes.rows as any[]) {
    const bucket = ensureBucket(Number(row.month_num), row.employee_id);
    bucket.anfahrt += Number(row.total_travel_minutes) || 0;
    bucket.otherWageCents += Number(row.travel_wage_cents) || 0;
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
    // Sonstiges-Zeiteinträge werden zum HW-Satz vergütet — pro Eintrags-Datum
    // über `wageFor` aufgelöst (ROUND pro Zeile, analog SQL-Aggregaten).
    const role = roleByEmployeeId[entry.userId] ?? "employee";
    bucket.otherWageCents += Math.round((minutes / 60) * resolveHwRateAt(role, entry.entryDate.slice(0, 10)));
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
    isAdmin: users.isAdmin,
    isSuperAdmin: users.isSuperAdmin,
    isTeamLead: users.isTeamLead,
    isActive: users.isActive,
    isAnonymized: users.isAnonymized,
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

  // Task #1503: Lohnsätze stammen aus der EINEN `wageFor`-SSoT (Rollen-Satz →
  // Katalog-Default), je leistendem Mitarbeiter über SEINE Rolle und PRO
  // Leistungsdatum aufgelöst (HW/AB direkt in SQL via resolvedWageCentsSql) —
  // nicht mehr aus der (entfernten) employee_compensation_history, die hier
  // dauerhaft 0 € lieferte, und nicht mehr nur am Monatsende.
  const [hwService] = await db.select({ id: services.id, rate: services.employeeRateCents })
    .from(services).where(eq(services.code, "hauswirtschaft")).limit(1);

  // HW-Rollen-Zeilen für die JS-seitige Auflösung (Feiertage + Sonstiges-Einträge,
  // die zum HW-Satz vergütet werden). HW/AB-Termine rechnen direkt in SQL.
  const hwWageRows = hwService
    ? await db.select({
        role: roleWageRates.role,
        cents: roleWageRates.cents,
        validFrom: roleWageRates.validFrom,
        validTo: roleWageRates.validTo,
        id: roleWageRates.id,
      }).from(roleWageRates).where(and(
        eq(roleWageRates.serviceId, hwService.id),
        isNull(roleWageRates.deletedAt),
      ))
    : [];

  const hwWageRowsByRole = new Map<string, VersionedWageRow[]>();
  for (const r of hwWageRows) {
    const list = hwWageRowsByRole.get(r.role) ?? [];
    list.push({ cents: r.cents, validFrom: r.validFrom, validTo: r.validTo, id: r.id });
    hwWageRowsByRole.set(r.role, list);
  }

  const roleByEmployeeId: Record<number, WageRole> = {};
  for (const emp of employees) {
    roleByEmployeeId[emp.id] = wageRoleForUserFlags(
      Boolean(emp.isSuperAdmin), Boolean(emp.isAdmin), isTeamLead(emp),
    );
  }

  // Auflösung über die SSoT: Existenz einer Rollen-Zeile gewinnt (auch 0 €),
  // sonst Katalog-Default — pro Datum (nicht mehr fix am Monatsende).
  const resolveHwRateAt = (role: WageRole, dateISO: string): number => {
    if (!hwService) return 0;
    const res = resolveWageFor({
      date: dateISO,
      roleRows: hwWageRowsByRole.get(role) ?? [],
      catalog: { employeeRateCents: hwService.rate },
    });
    return res?.cents ?? 0;
  };

  const minijobberIds = employees.filter(e => e.employmentType === "minijobber").map(e => e.id);
  const carryoverByEmployee: Record<number, number> = {};

  const allMonthsHours = await getMonthlyHoursBatch(employeeIds, year, 1, month, roleByEmployeeId, resolveHwRateAt);

  if (minijobberIds.length > 0) {
    for (let m = 1; m < month; m++) {
      const monthData = allMonthsHours[m] || {};
      const lastDayOfM = new Date(year, m, 0).getDate();
      const monthEndISO = `${year}-${String(m).padStart(2, "0")}-${String(lastDayOfM).padStart(2, "0")}`;

      for (const empId of minijobberIds) {
        const role = roleByEmployeeId[empId] ?? "employee";
        const hours = monthData[empId] || emptyBucket();
        const emp = employees.find(e => e.id === empId)!;
        const feiertage = calculateHolidayHours(year, m, emp.employmentType, emp.monthlyWorkHours);
        const feiertagCents = Math.round(feiertage * resolveHwRateAt(role, monthEndISO));

        // Erstberatung + Anfahrt + Sonstiges sind bereits in otherWageCents zum
        // HW-Satz pro Datum aggregiert (vorher als „sonstiges" zusammengefasst).
        const prevCarryover = carryoverByEmployee[empId] || 0;
        const bruttoComponents = hours.hwWageCents + hours.abWageCents + hours.otherWageCents + feiertagCents;
        if (bruttoComponents === 0 && prevCarryover === 0) continue;

        const result = calculateBruttoAndCarryover(
          hours.hwWageCents,
          hours.abWageCents,
          hours.otherWageCents,
          feiertagCents,
          earningsLimitCents,
          prevCarryover
        );
        carryoverByEmployee[empId] = result.carryoverCents;
      }
    }
  }

  const currentMonthHours = allMonthsHours[month] || {};

  const unsignedResult = await db.execute(sql`
    SELECT
      a.performed_by_employee_id as employee_id,
      COUNT(DISTINCT a.id) as unsigned_count,
      COALESCE(SUM(svc_minutes.minutes), 0) as unsigned_minutes
    FROM appointments a
    ${unsignedServiceMinutesLateralRaw('a', 'svc_minutes')}
    WHERE ${completedButUnsignedSqlRaw('a')}
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
    GROUP BY a.performed_by_employee_id
  `);

  const unsignedCountByEmployee: Record<number, number> = {};
  const unsignedMinutesByEmployee: Record<number, number> = {};
  for (const row of unsignedResult.rows as any[]) {
    unsignedCountByEmployee[row.employee_id] = Number(row.unsigned_count) || 0;
    unsignedMinutesByEmployee[row.employee_id] = Number(row.unsigned_minutes) || 0;
  }

  const kmResult = await db.execute(sql`
    SELECT 
      performed_by_employee_id as employee_id,
      COALESCE(SUM(COALESCE(travel_kilometers, 0)), 0) as travel_km,
      COALESCE(SUM(COALESCE(customer_kilometers, 0)), 0) as customer_km
    FROM appointments a
    WHERE ${documentedSqlRaw('a')}
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
      const role = roleByEmployeeId[emp.id] ?? "employee";
      const feiertagCents = Math.round(feiertage * resolveHwRateAt(role, endDate));
      const prevCarryoverCents = carryoverByEmployee[emp.id] || 0;
      const bruttoComponents = hours.hwWageCents + hours.abWageCents + hours.otherWageCents + feiertagCents;
      if (bruttoComponents > 0 || prevCarryoverCents > 0) {
        uebertragVormonatCents = prevCarryoverCents;

        // Erstberatung + Anfahrt + Sonstiges sind bereits in otherWageCents zum
        // HW-Satz pro Datum aggregiert (vorher als „sonstiges" zusammengefasst).
        const result = calculateBruttoAndCarryover(
          hours.hwWageCents, hours.abWageCents, hours.otherWageCents, feiertagCents,
          earningsLimitCents, prevCarryoverCents
        );
        bruttoCents = result.bruttoCents;
        auszahlbarCents = result.auszahlbarCents;
        uebertragNeuCents = result.carryoverCents;
      }
    }

    const unsignedAppointmentCount = unsignedCountByEmployee[emp.id] || 0;
    const unsignedMinutes = unsignedMinutesByEmployee[emp.id] || 0;

    if (
      stundenHW > 0 || stundenAB > 0 || stundenErstberatung > 0 || stundenAnfahrt > 0 ||
      stundenSonstiges > 0 || km > 0 || urlaub > 0 || krankheit > 0 || feiertage > 0 ||
      unsignedAppointmentCount > 0
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
        unsignedAppointmentCount,
        unsignedMinutes,
      });
    }
  }

  rows.sort((a, b) => a.nachname.localeCompare(b.nachname) || a.vorname.localeCompare(b.vorname));

  res.json({ rows, year, month, earningsLimitCents });
}));

interface UnsignedAppointmentRow {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  minutes: number;
}

// Liste der completed-aber-unsignierten Termine eines Mitarbeiters im gewählten
// Monat — Sprung-Ziel aus der Warnung „N Termine ohne Unterschrift" der
// Stundenübersicht. Nutzt dasselbe Prädikat (`completedButUnsignedSqlRaw`) wie
// die Warnzählung in `/hours-overview`, damit Liste und Zähler konsistent sind.
router.get("/hours-overview/unsigned-appointments", asyncHandler("Nicht unterschriebene Termine konnten nicht geladen werden", async (req: Request, res: Response) => {
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
