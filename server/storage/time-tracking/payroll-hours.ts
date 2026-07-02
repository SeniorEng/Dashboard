/**
 * Task #1555 — SSoT der Mitarbeiter-Stunden-Aggregation ("Mitarbeiterabrechnung
 * & Stundenkonto"). Konsolidiert die frühere `/hours-overview`-Aggregation aus
 * `routes/admin/lexware-export.ts` an EINE Stelle, damit Übersicht, Stundenkonto
 * und Drill-down dieselben Zahlen lesen.
 *
 * Rohwerte kommen aus dokumentierten Terminen (`documentedSqlRaw` = status
 * 'completed', bewusst entkoppelt von der Unterschrift) plus manuellen
 * Zeiteinträgen. Lohnsätze über die `wageFor`-SSoT (Rollen-Satz → Katalog),
 * pro Leistungsdatum aufgelöst.
 */
import { db } from "../../lib/db";
import { users } from "@shared/schema/users";
import { companySettings } from "@shared/schema/company";
import { roleWageRates } from "@shared/schema/contracts";
import { services } from "@shared/schema/services";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { and, gte, lte, sql, inArray, eq, isNull } from "drizzle-orm";
import { employeeTimeEntriesRepo } from "../../repos";
import { getHolidays } from "@shared/utils/holidays";
import { parseLocalDate } from "@shared/utils/datetime";
import { documentedSqlRaw, completedButUnsignedSqlRaw, unsignedServiceMinutesLateralRaw } from "../../lib/appointment-signed";
import { resolveWageFor, wageRoleForUserFlags, type WageRole, type VersionedWageRow } from "@shared/domain/pricing/wage-for";
import { NO_SHOW_WAIT_CAP_MINUTES } from "@shared/domain/no-show-wage";
import { resolvedWageCentsSql, wageRoleSql } from "../pricing/wage-for-sql";
import { isTeamLead } from "../../lib/team-lead";

const DEFAULT_MINIJOB_LIMIT_CENTS = 60300;

// Zeiteintrags-Typen, die als bezahlte Arbeitszeit zählen (deckungsgleich mit
// der Mitarbeiter-„Meine Zeiten"-Sicht). Urlaub/Krankheit werden separat als
// Tage geführt (siehe unten), Pause/Verfügbar/Blocker zählen nicht.
const PAID_MANUAL_ENTRY_TYPES = new Set(["bueroarbeit", "vertrieb", "sonstiges"]);

export interface EmployeeMeta {
  id: number;
  vorname: string;
  nachname: string;
  isEuRentner: boolean;
  employmentType: string;
  weeklyWorkDays: number;
  monthlyWorkHours: number | null;
  role: WageRole;
}

export interface CategoryErfasst {
  hw: number;
  ab: number;
  feiertage: number;
  kilometer: number;
}

export interface MinijobPay {
  bruttoCents: number;
  uebertragVormonatCents: number;
  auszahlbarCents: number;
  uebertragNeuCents: number;
  limitCents: number;
  kappung: boolean;
}

export interface PayrollEmployeeRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  employmentType: string;
  weeklyWorkDays: number;
  monthlyWorkHours: number | null;
  isEuRentner: boolean;
  dailySollHours: number;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenErstberatung: number;
  stundenAnfahrt: number;
  stundenSonstiges: number;
  /** Task #167 — Leerfahrten (customer_no_show): bezahlte Stunden = origin-gated
   * Fahrtzeit + gedeckelte Wartezeit (SSoT computeNoShowWage). In `erfasst.hw`
   * und die Minijob-Auszahlung eingerechnet. */
  stundenLeerfahrten: number;
  stundenFeiertage: number;
  tageUrlaub: number;
  tageKrankheit: number;
  urlaubStunden: number;
  krankheitStunden: number;
  kilometer: number;
  kilometerAnfahrt: number;
  kilometerKunden: number;
  kilometerSonstige: number;
  /** Task #167 — Leerfahrten-Anfahrt-km (aus `noShowKilometers`), im km-Total
   * enthalten. */
  kilometerLeerfahrten: number;
  erfasst: CategoryErfasst;
  minijob: MinijobPay | null;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
  /** Hat der Mitarbeiter in DIESEM Monat erfasste Aktivität (Stunden, km,
   * Urlaub/Krankheit oder offene Termine)? Zeilen ohne Aktivität werden vom
   * Aufrufer nur dann angezeigt, wenn ein materielles Stundenkonto existiert
   * (Übertrag/Saldo) — damit Übertrags-Mitarbeiter nicht verschwinden. */
  hasActivity: boolean;
}

export interface PayrollResult {
  rows: PayrollEmployeeRow[];
  employees: EmployeeMeta[];
  earningsLimitCents: number;
}

/** Vertragliches Soll pro Arbeitstag (Stunden) — für Umrechnung Urlaubs-/
 * Kranktage → Stunden und Feiertags-Stunden. Minijobber ohne hinterlegte
 * Monatsstunden: 2,5 h (deckungsgleich mit der Feiertags-Logik). */
export function dailySollHours(employmentType: string, monthlyWorkHours: number | null): number {
  if (monthlyWorkHours && monthlyWorkHours > 0) {
    return Math.round((monthlyWorkHours / 21.7) * 100) / 100;
  }
  if (employmentType === "minijobber") return 2.5;
  return 0;
}

export function calculateHolidayHours(
  year: number,
  month: number,
  employmentType: string,
  monthlyWorkHours: number | null,
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
      if (dayOfWeek === 1 || dayOfWeek === 2) totalHours += 2.5;
    } else if (monthlyWorkHours && monthlyWorkHours > 0) {
      totalHours += Math.round((monthlyWorkHours / 21.7) * 100) / 100;
    }
  }
  return Math.round(totalHours * 100) / 100;
}

/** Minijob-Kappung: Brutto (inkl. Vormonats-Übertrag) wird auf die
 * Verdienstgrenze gedeckelt, Rest als Übertrag in den Folgemonat. */
export function calculateBruttoAndCarryover(
  bruttoCents: number,
  earningsLimitCents: number,
  carryoverCentsFromPrev: number,
): { bruttoCents: number; auszahlbarCents: number; carryoverCents: number } {
  const totalPayableCents = bruttoCents + carryoverCentsFromPrev;
  if (totalPayableCents <= earningsLimitCents) {
    return { bruttoCents, auszahlbarCents: totalPayableCents, carryoverCents: 0 };
  }
  return {
    bruttoCents,
    auszahlbarCents: earningsLimitCents,
    carryoverCents: totalPayableCents - earningsLimitCents,
  };
}

interface RawMonthBucket {
  hwMin: number;
  abMin: number;
  erstMin: number;
  anfMin: number;
  sonstMin: number;
  hwWageCents: number;
  abWageCents: number;
  otherWageCents: number;
  // Task #167 — Leerfahrten (customer_no_show): eigene Kategorie, damit
  // Übersicht & Abrechnung dieselbe Taxonomie teilen. leerMin = origin-gated
  // Fahrtzeit + gedeckelte Wartezeit (SSoT computeNoShowWage), NICHT geplante
  // Dauer; leerWageCents wird in die Minijob-Brutto-Summe eingerechnet.
  leerMin: number;
  leerWageCents: number;
  leerKm: number;
  travelKm: number;
  customerKm: number;
  entryKm: number;
  urlaubDays: number;
  krankDays: number;
}

function emptyRaw(): RawMonthBucket {
  return {
    hwMin: 0, abMin: 0, erstMin: 0, anfMin: 0, sonstMin: 0,
    hwWageCents: 0, abWageCents: 0, otherWageCents: 0,
    leerMin: 0, leerWageCents: 0, leerKm: 0,
    travelKm: 0, customerKm: 0, entryKm: 0,
    urlaubDays: 0, krankDays: 0,
  };
}

interface PayrollContext {
  employees: EmployeeMeta[];
  earningsLimitCents: number;
  hwService: { id: number; rate: number } | null;
  resolveHwRateAt: (role: WageRole, dateISO: string) => number;
}

async function loadContext(): Promise<PayrollContext> {
  const employeeRows = await db.select({
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

  const employees: EmployeeMeta[] = employeeRows.map(e => ({
    id: e.id,
    vorname: e.vorname || "",
    nachname: e.nachname || "",
    isEuRentner: e.isEuRentner,
    employmentType: e.employmentType,
    weeklyWorkDays: e.weeklyWorkDays,
    monthlyWorkHours: e.monthlyWorkHours,
    role: wageRoleForUserFlags(Boolean(e.isSuperAdmin), Boolean(e.isAdmin), isTeamLead(e)),
  }));

  const [companySettingsRow] = await db.select({
    minijobEarningsLimitCents: companySettings.minijobEarningsLimitCents,
  }).from(companySettings).limit(1);
  const earningsLimitCents = companySettingsRow?.minijobEarningsLimitCents ?? DEFAULT_MINIJOB_LIMIT_CENTS;

  const [hwService] = await db.select({ id: services.id, rate: services.employeeRateCents })
    .from(services).where(eq(services.code, "hauswirtschaft")).limit(1);

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

  const resolveHwRateAt = (role: WageRole, dateISO: string): number => {
    if (!hwService) return 0;
    const res = resolveWageFor({
      date: dateISO,
      roleRows: hwWageRowsByRole.get(role) ?? [],
      catalog: { employeeRateCents: hwService.rate },
    });
    return res?.cents ?? 0;
  };

  return { employees, earningsLimitCents, hwService, resolveHwRateAt };
}

type BucketMap = Record<number, Record<number, RawMonthBucket>>;

/** Aggregiert die Roh-Buckets für alle aktiven Mitarbeiter über den Bereich
 * `fromMonth..toMonth` eines Jahres in wenigen gruppierten Queries. */
async function computeRawBuckets(
  employeeIds: number[],
  year: number,
  fromMonth: number,
  toMonth: number,
  roleByEmployeeId: Record<number, WageRole>,
  resolveHwRateAt: (role: WageRole, dateISO: string) => number,
): Promise<BucketMap> {
  const startDate = `${year}-${String(fromMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(year, toMonth, 0).getDate();
  const endDate = `${year}-${String(toMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const result: BucketMap = {};
  const ensure = (m: number, empId: number): RawMonthBucket => {
    if (!result[m]) result[m] = {};
    if (!result[m][empId]) result[m][empId] = emptyRaw();
    return result[m][empId];
  };

  if (employeeIds.length === 0) return result;
  const empArray = sql`ARRAY[${sql.join(employeeIds.map(id => sql`${id}`), sql`, `)}]::int[]`;

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
      AND a.performed_by_employee_id = ANY(${empArray})
      AND s.unit_type = 'hours'
      AND s.code IN ('hauswirtschaft', 'alltagsbegleitung', 'erstberatung')
    GROUP BY a.performed_by_employee_id, s.code, EXTRACT(MONTH FROM a.date::date)
  `);
  for (const row of appointmentHours.rows as any[]) {
    const bucket = ensure(Number(row.month_num), row.employee_id);
    const minutes = Number(row.minutes) || 0;
    const wageCents = Number(row.wage_cents) || 0;
    const code = row.service_code as string;
    if (code === "alltagsbegleitung") {
      bucket.abMin += minutes;
      bucket.abWageCents += wageCents;
    } else if (code === "hauswirtschaft") {
      bucket.hwMin += minutes;
      bucket.hwWageCents += wageCents;
    } else if (code === "erstberatung") {
      bucket.erstMin += minutes;
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
      AND a.performed_by_employee_id = ANY(${empArray})
      AND a.travel_minutes > 0
    GROUP BY a.performed_by_employee_id, EXTRACT(MONTH FROM a.date::date)
  `);
  for (const row of travelMinutes.rows as any[]) {
    const bucket = ensure(Number(row.month_num), row.employee_id);
    bucket.anfMin += Number(row.total_travel_minutes) || 0;
    bucket.otherWageCents += Number(row.travel_wage_cents) || 0;
  }

  const kmResult = await db.execute(sql`
    SELECT
      performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM date::date) as month_num,
      COALESCE(SUM(COALESCE(travel_kilometers, 0)), 0) as travel_km,
      COALESCE(SUM(COALESCE(customer_kilometers, 0)), 0) as customer_km
    FROM appointments a
    WHERE ${documentedSqlRaw('a')}
      AND deleted_at IS NULL
      AND date >= ${startDate}
      AND date <= ${endDate}
      AND performed_by_employee_id = ANY(${empArray})
    GROUP BY performed_by_employee_id, EXTRACT(MONTH FROM date::date)
  `);
  for (const row of kmResult.rows as any[]) {
    const bucket = ensure(Number(row.month_num), row.employee_id);
    bucket.travelKm += Number(row.travel_km) || 0;
    bucket.customerKm += Number(row.customer_km) || 0;
  }

  // Task #167 — Leerfahrten (customer_no_show): bewusst NICHT über
  // `documentedSqlRaw` (das ist completed-only) gefiltert — ein No-Show ist per
  // Definition nicht `completed`. Stattdessen ein separater
  // `status = 'customer_no_show'`-Branch. Die Lohn-Minuten spiegeln EXAKT die
  // SSoT `computeNoShowWage` (shared/domain/no-show-wage.ts): origin-gated
  // Fahrtzeit (`travel_minutes` nur wenn `travel_origin_type = 'appointment'`)
  // + `LEAST(no_show_wait_minutes, NO_SHOW_WAIT_CAP_MINUTES)`. Km ausschließlich
  // aus `no_show_kilometers`. Bei Änderung an computeNoShowWage MUSS diese
  // Query im Gleichschritt angepasst werden (Anti-Drift-Test gesichert).
  const noShow = await db.execute(sql`
    SELECT
      a.performed_by_employee_id as employee_id,
      EXTRACT(MONTH FROM a.date::date) as month_num,
      SUM(
        CASE WHEN a.travel_origin_type = 'appointment' THEN GREATEST(COALESCE(a.travel_minutes, 0), 0) ELSE 0 END
        + LEAST(${NO_SHOW_WAIT_CAP_MINUTES}, GREATEST(COALESCE(a.no_show_wait_minutes, 0), 0))
      ) as leer_minutes,
      SUM(ROUND((
        CASE WHEN a.travel_origin_type = 'appointment' THEN GREATEST(COALESCE(a.travel_minutes, 0), 0) ELSE 0 END
        + LEAST(${NO_SHOW_WAIT_CAP_MINUTES}, GREATEST(COALESCE(a.no_show_wait_minutes, 0), 0))
      ) / 60.0 * ${hwRateForOther})) as leer_wage_cents,
      COALESCE(SUM(GREATEST(COALESCE(a.no_show_kilometers, 0), 0)), 0) as leer_km
    FROM appointments a
    JOIN users u ON u.id = a.performed_by_employee_id
    CROSS JOIN (SELECT id, employee_rate_cents FROM services WHERE code = 'hauswirtschaft' LIMIT 1) hw
    WHERE a.status = 'customer_no_show'
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ANY(${empArray})
    GROUP BY a.performed_by_employee_id, EXTRACT(MONTH FROM a.date::date)
  `);
  for (const row of noShow.rows as any[]) {
    const bucket = ensure(Number(row.month_num), row.employee_id);
    bucket.leerMin += Number(row.leer_minutes) || 0;
    bucket.leerWageCents += Number(row.leer_wage_cents) || 0;
    bucket.leerKm += Number(row.leer_km) || 0;
  }

  const timeEntries = await employeeTimeEntriesRepo.selectColumnsFrom({
    userId: employeeTimeEntries.userId,
    entryType: employeeTimeEntries.entryType,
    entryDate: employeeTimeEntries.entryDate,
    durationMinutes: employeeTimeEntries.durationMinutes,
    startTime: employeeTimeEntries.startTime,
    endTime: employeeTimeEntries.endTime,
    kilometers: employeeTimeEntries.kilometers,
  }).where(
    and(
      inArray(employeeTimeEntries.userId, employeeIds),
      gte(employeeTimeEntries.entryDate, startDate),
      lte(employeeTimeEntries.entryDate, endDate),
      employeeTimeEntriesRepo.activeOnly(),
    ),
  );
  for (const entry of timeEntries) {
    const m = parseLocalDate(entry.entryDate).getMonth() + 1;
    const bucket = ensure(m, entry.userId);
    bucket.entryKm += entry.kilometers || 0;

    if (entry.entryType === "urlaub") {
      bucket.urlaubDays += 1;
    } else if (entry.entryType === "krankheit") {
      bucket.krankDays += 1;
    }

    if (PAID_MANUAL_ENTRY_TYPES.has(entry.entryType)) {
      let minutes = entry.durationMinutes || 0;
      if (!minutes && entry.startTime && entry.endTime) {
        const [sh, sm] = entry.startTime.split(":").map(Number);
        const [eh, em] = entry.endTime.split(":").map(Number);
        minutes = (eh * 60 + em) - (sh * 60 + sm);
      }
      bucket.sonstMin += minutes;
      const role = roleByEmployeeId[entry.userId] ?? "employee";
      bucket.otherWageCents += Math.round((minutes / 60) * resolveHwRateAt(role, entry.entryDate.slice(0, 10)));
    }
  }

  return result;
}

function rowFromBucket(
  emp: EmployeeMeta,
  raw: RawMonthBucket,
  year: number,
  month: number,
): Omit<PayrollEmployeeRow, "minijob" | "unsignedAppointmentCount" | "unsignedMinutes"> {
  const soll = dailySollHours(emp.employmentType, emp.monthlyWorkHours);
  const stundenHW = raw.hwMin / 60;
  const stundenAB = raw.abMin / 60;
  const stundenErst = raw.erstMin / 60;
  const stundenAnf = raw.anfMin / 60;
  const stundenSonst = raw.sonstMin / 60;
  const stundenLeer = raw.leerMin / 60;
  const feiertage = calculateHolidayHours(year, month, emp.employmentType, emp.monthlyWorkHours);
  const urlaubStunden = Math.round(raw.urlaubDays * soll * 100) / 100;
  const krankheitStunden = Math.round(raw.krankDays * soll * 100) / 100;
  const kmAnfahrt = raw.travelKm;
  const kmKunden = raw.customerKm;
  const kmSonstige = raw.entryKm;
  const kmLeer = raw.leerKm;
  const km = kmAnfahrt + kmKunden + kmSonstige + kmLeer;

  const r2 = (n: number) => Math.round(n * 100) / 100;
  // Task #167: Leerfahrten-Stunden fließen in die "Erfasst"-Summe ein, damit
  // die Kategorie-Taxonomie mit der Mitarbeiter-Sicht übereinstimmt.
  const hwErfasst = r2(stundenHW + stundenSonst + stundenErst + stundenAnf + stundenLeer + urlaubStunden + krankheitStunden);

  const hasActivity =
    raw.hwMin > 0 || raw.abMin > 0 || raw.erstMin > 0 || raw.anfMin > 0 || raw.sonstMin > 0 ||
    raw.leerMin > 0 || raw.leerKm > 0 ||
    raw.travelKm > 0 || raw.customerKm > 0 || raw.entryKm > 0 ||
    raw.urlaubDays > 0 || raw.krankDays > 0;

  return {
    hasActivity,
    employeeId: emp.id,
    nachname: emp.nachname,
    vorname: emp.vorname,
    employmentType: emp.employmentType,
    weeklyWorkDays: emp.weeklyWorkDays,
    monthlyWorkHours: emp.monthlyWorkHours,
    isEuRentner: emp.isEuRentner,
    dailySollHours: soll,
    stundenHauswirtschaft: r2(stundenHW),
    stundenAlltagsbegleitung: r2(stundenAB),
    stundenErstberatung: r2(stundenErst),
    stundenAnfahrt: r2(stundenAnf),
    stundenSonstiges: r2(stundenSonst),
    stundenLeerfahrten: r2(stundenLeer),
    stundenFeiertage: feiertage,
    tageUrlaub: raw.urlaubDays,
    tageKrankheit: raw.krankDays,
    urlaubStunden,
    krankheitStunden,
    kilometer: Math.round(km * 10) / 10,
    kilometerAnfahrt: Math.round(kmAnfahrt * 10) / 10,
    kilometerKunden: Math.round(kmKunden * 10) / 10,
    kilometerSonstige: Math.round(kmSonstige * 10) / 10,
    kilometerLeerfahrten: Math.round(kmLeer * 10) / 10,
    erfasst: {
      hw: hwErfasst,
      ab: r2(stundenAB),
      feiertage,
      kilometer: Math.round(km * 10) / 10,
    },
  };
}

/** Erfasst pro Kategorie für jeden Monat 1..uptoMonth (für die
 * Stundenkonto-Übertragskette). */
export async function getMonthlyCategoryErfasst(
  year: number,
  uptoMonth: number,
): Promise<{ byEmployeeMonth: Record<number, Record<number, CategoryErfasst>>; employees: EmployeeMeta[] }> {
  const ctx = await loadContext();
  const employeeIds = ctx.employees.map(e => e.id);
  const roleByEmployeeId: Record<number, WageRole> = {};
  for (const e of ctx.employees) roleByEmployeeId[e.id] = e.role;

  const buckets = await computeRawBuckets(employeeIds, year, 1, uptoMonth, roleByEmployeeId, ctx.resolveHwRateAt);

  const byEmployeeMonth: Record<number, Record<number, CategoryErfasst>> = {};
  for (const emp of ctx.employees) {
    byEmployeeMonth[emp.id] = {};
    for (let m = 1; m <= uptoMonth; m++) {
      const raw = buckets[m]?.[emp.id] || emptyRaw();
      const row = rowFromBucket(emp, raw, year, m);
      byEmployeeMonth[emp.id][m] = row.erfasst;
    }
  }
  return { byEmployeeMonth, employees: ctx.employees };
}

/** Volle Zeilen für den gewählten Monat (Übersicht + Aufschlüsselung). */
export async function getEmployeePayrollRows(year: number, month: number): Promise<PayrollResult> {
  const ctx = await loadContext();
  const employeeIds = ctx.employees.map(e => e.id);
  if (employeeIds.length === 0) {
    return { rows: [], employees: [], earningsLimitCents: ctx.earningsLimitCents };
  }

  const roleByEmployeeId: Record<number, WageRole> = {};
  for (const e of ctx.employees) roleByEmployeeId[e.id] = e.role;

  const buckets = await computeRawBuckets(employeeIds, year, 1, month, roleByEmployeeId, ctx.resolveHwRateAt);

  // Minijob-Übertragskette (Jan..Vormonat) für die Kappung.
  const minijobberIds = ctx.employees.filter(e => e.employmentType === "minijobber").map(e => e.id);
  const carryoverByEmployee: Record<number, number> = {};
  if (minijobberIds.length > 0) {
    for (let m = 1; m < month; m++) {
      const lastDayOfM = new Date(year, m, 0).getDate();
      const monthEndISO = `${year}-${String(m).padStart(2, "0")}-${String(lastDayOfM).padStart(2, "0")}`;
      for (const empId of minijobberIds) {
        const emp = ctx.employees.find(e => e.id === empId)!;
        const raw = buckets[m]?.[empId] || emptyRaw();
        const feiertage = calculateHolidayHours(year, m, emp.employmentType, emp.monthlyWorkHours);
        const feiertagCents = Math.round(feiertage * ctx.resolveHwRateAt(emp.role, monthEndISO));
        const brutto = raw.hwWageCents + raw.abWageCents + raw.otherWageCents + raw.leerWageCents + feiertagCents;
        const prev = carryoverByEmployee[empId] || 0;
        if (brutto === 0 && prev === 0) continue;
        const res = calculateBruttoAndCarryover(brutto, ctx.earningsLimitCents, prev);
        carryoverByEmployee[empId] = res.carryoverCents;
      }
    }
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const monthEndISO = endDate;

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

  const rows: PayrollEmployeeRow[] = [];
  for (const emp of ctx.employees) {
    const raw = buckets[month]?.[emp.id] || emptyRaw();
    const base = rowFromBucket(emp, raw, year, month);
    const unsignedAppointmentCount = unsignedCountByEmployee[emp.id] || 0;
    const unsignedMinutes = unsignedMinutesByEmployee[emp.id] || 0;

    let minijob: MinijobPay | null = null;
    if (emp.employmentType === "minijobber") {
      const feiertagCents = Math.round(base.stundenFeiertage * ctx.resolveHwRateAt(emp.role, monthEndISO));
      const brutto = raw.hwWageCents + raw.abWageCents + raw.otherWageCents + raw.leerWageCents + feiertagCents;
      const prev = carryoverByEmployee[emp.id] || 0;
      if (brutto > 0 || prev > 0) {
        const res = calculateBruttoAndCarryover(brutto, ctx.earningsLimitCents, prev);
        minijob = {
          bruttoCents: res.bruttoCents,
          uebertragVormonatCents: prev,
          auszahlbarCents: res.auszahlbarCents,
          uebertragNeuCents: res.carryoverCents,
          limitCents: ctx.earningsLimitCents,
          kappung: res.carryoverCents > 0,
        };
      }
    }

    const hasActivity =
      base.erfasst.hw > 0 || base.erfasst.ab > 0 || base.erfasst.feiertage > 0 ||
      base.erfasst.kilometer > 0 || base.tageUrlaub > 0 || base.tageKrankheit > 0 ||
      unsignedAppointmentCount > 0;

    // Zeilen ohne Aktivität NICHT mehr verwerfen — der Aufrufer entscheidet
    // anhand von hasActivity + materiellem Stundenkonto über die Anzeige, damit
    // Mitarbeiter mit reinem Übertragssaldo nicht aus der Liste fallen.
    rows.push({ ...base, minijob, unsignedAppointmentCount, unsignedMinutes, hasActivity });
  }

  rows.sort((a, b) => a.nachname.localeCompare(b.nachname) || a.vorname.localeCompare(b.vorname));
  return { rows, employees: ctx.employees, earningsLimitCents: ctx.earningsLimitCents };
}
