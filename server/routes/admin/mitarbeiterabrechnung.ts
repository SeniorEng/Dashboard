/**
 * Task #1555 — "Mitarbeiterabrechnung & Stundenkonto".
 *
 * Konsolidiert die früheren Oberflächen Zeiterfassung (`/admin/time-entries`)
 * und Stundenübersicht (`/admin/hours-overview`) in EINEN Monatsabschluss-
 * Screen: 6-KPI-Board, aggregierte Tabelle (eine Zeile je Mitarbeiter) und
 * Drill-down pro Mitarbeiter. Zahlen kommen aus der SSoT `payroll-hours`;
 * das Stundenkonto (Auszahl-Rückstand) aus `payroll-accounts`.
 */
import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { and, eq, sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { requireWageDataAccess } from "../../middleware/auth";
import { employeeMonthClosings } from "@shared/schema/system";
import { completedButUnsignedSqlRaw, unsignedServiceMinutesLateralRaw, documentedSqlRaw } from "../../lib/appointment-signed";
import { upsertHoursAccountSchema, HOURS_ACCOUNT_CATEGORIES } from "@shared/schema/time-tracking";
import { getEmployeePayrollRows, getMonthlyAbsenceBlocks, type PayrollEmployeeRow } from "../../storage/time-tracking/payroll-hours";
import { computeAccountsForMonth, upsertHoursAccount, OpeningBalanceLockedError, type AccountCell } from "../../storage/time-tracking/payroll-accounts";
import { resolveAppointmentPartyName } from "@shared/domain/appointment-party-name";

const router = Router();

/**
 * Task #1569/#1570/#1571 — Termine ohne Kundenzuordnung sind fast immer
 * Interessenten-/Erstberatungstermine (`customer_id` NULL, `prospect_id`
 * gesetzt). Statt eines nichtssagenden Platzhalters wird überall der
 * Interessenten-Name ("Interessent: <Name>") angezeigt. Die Auflöse-Logik lebt
 * jetzt als geteilte SSoT in `@shared/domain/appointment-party-name`
 * (`resolveAppointmentPartyName`), damit alle Termin-Listen (Mitarbeiter-
 * abrechnung, Lexware-/Payroll-Export …) identisch auflösen.
 */

function parseYearMonth(req: Request, res: Response): { year: number; month: number } | null {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return null;
  }
  return { year, month };
}

function prevPeriod(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

// Task #1616 — „Erfasste Stunden" = HW + AB (deckungsgleich mit den beiden
// Tabellenspalten). Feiertage/Urlaub/Krankheit werden separat geführt und
// zählen NICHT zur Erfasst-Summe.
function sumHours(rows: PayrollEmployeeRow[]): number {
  const total = rows.reduce((s, r) => s + r.erfasst.hw + r.erfasst.ab, 0);
  return Math.round(total * 100) / 100;
}
/** Abrechenbare (produktive) Stunden = rohe Hauswirtschaft + Alltagsbegleitung. */
function sumBillableHours(rows: PayrollEmployeeRow[]): number {
  const total = rows.reduce((s, r) => s + r.stundenHauswirtschaft + r.stundenAlltagsbegleitung, 0);
  return Math.round(total * 100) / 100;
}
function sumKm(rows: PayrollEmployeeRow[]): number {
  const total = rows.reduce((s, r) => s + r.erfasst.kilometer, 0);
  return Math.round(total * 10) / 10;
}
function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function loadClosedSet(year: number, month: number): Promise<Set<number>> {
  const rows = await db
    .select({ userId: employeeMonthClosings.userId, reopenedAt: employeeMonthClosings.reopenedAt })
    .from(employeeMonthClosings)
    .where(and(eq(employeeMonthClosings.year, year), eq(employeeMonthClosings.month, month)));
  const set = new Set<number>();
  for (const r of rows) if (!r.reopenedAt) set.add(r.userId);
  return set;
}

// GET /mitarbeiterabrechnung — Übersicht (KPIs + Tabelle)
router.get("/mitarbeiterabrechnung", requireWageDataAccess, asyncHandler("Mitarbeiterabrechnung konnte nicht geladen werden", async (req: Request, res: Response) => {
  const period = parseYearMonth(req, res);
  if (!period) return;
  const { year, month } = period;

  const [{ rows, earningsLimitCents }, { byEmployee: accounts }, closedSet] = await Promise.all([
    getEmployeePayrollRows(year, month),
    computeAccountsForMonth(year, month),
    loadClosedSet(year, month),
  ]);

  const prev = prevPeriod(year, month);
  const { rows: prevRows } = await getEmployeePayrollRows(prev.year, prev.month);

  const absenceBlocks = await getMonthlyAbsenceBlocks(year, month, rows.map((r) => r.employeeId));

  const r2 = (n: number) => Math.round(n * 100) / 100;

  let stundenkontoSaldo = 0;
  let unsignedHours = 0;
  let unsignedCount = 0;
  let minijobKappungCount = 0;

  // Alle Zeilen anreichern (Stundenkonto/Saldo), danach für die Anzeige
  // filtern: Aktivität ODER materielles Stundenkonto (Übertrag/Saldo/manuell
  // gepflegtes „Bezahlt"). So bleiben reine Übertrags-Mitarbeiter sichtbar,
  // ohne die Liste mit komplett leeren Zeilen zu fluten.
  const enriched = rows.map((r) => {
    const cells = accounts[r.employeeId] ?? {};
    const cellList = Object.values(cells);
    const saldo = {
      hw: cells.hw?.saldo ?? 0,
      ab: cells.ab?.saldo ?? 0,
      feiertage: cells.feiertage?.saldo ?? 0,
      kilometer: cells.kilometer?.saldo ?? 0,
    };
    const stundenkonto = Math.round((saldo.hw + saldo.ab + saldo.feiertage) * 100) / 100;
    const materialAccount = cellList.some(
      (c) => c.saldo !== 0 || c.anfangsbestand !== 0 || !c.bezahltIsDefault,
    );
    const visible = r.hasActivity || materialAccount;

    return {
      row: r,
      visible,
      payload: {
        employeeId: r.employeeId,
        vorname: r.vorname,
        nachname: r.nachname,
        employmentType: r.employmentType,
        isEuRentner: r.isEuRentner,
        erfasst: r.erfasst,
        abwesenheiten: absenceBlocks[r.employeeId] ?? [],
        saldo,
        stundenkontoSaldo: stundenkonto,
        kilometerSaldo: saldo.kilometer,
        unsignedAppointmentCount: r.unsignedAppointmentCount,
        unsignedMinutes: r.unsignedMinutes,
        minijob: r.minijob,
        isClosed: closedSet.has(r.employeeId),
      },
    };
  });

  const visibleEntries = enriched.filter((e) => e.visible);
  const tableRows = visibleEntries.map((e) => e.payload);

  for (const e of visibleEntries) {
    stundenkontoSaldo += e.payload.stundenkontoSaldo;
    unsignedHours += e.row.unsignedMinutes / 60;
    unsignedCount += e.row.unsignedAppointmentCount;
    if (e.row.minijob?.kappung) minijobKappungCount += 1;
  }

  // KPI-Board (6 Kacheln). „Erfasst" = produktiv + Gemeinkosten (Wasserkopf).
  const visibleRows = visibleEntries.map((e) => e.row);
  const erfassteStunden = sumHours(visibleRows);
  const prevErfassteStunden = sumHours(prevRows);
  const abrechenbareStunden = sumBillableHours(visibleRows);
  const prevAbrechenbareStunden = sumBillableHours(prevRows);
  const gemeinkostenStunden = r2(erfassteStunden - abrechenbareStunden);
  const prevGemeinkostenStunden = r2(prevErfassteStunden - prevAbrechenbareStunden);
  const produktivquote = erfassteStunden > 0
    ? Math.round((abrechenbareStunden / erfassteStunden) * 1000) / 10
    : null;

  res.json({
    year,
    month,
    earningsLimitCents,
    standDate: new Date().toISOString(),
    kpis: {
      // (1) Erfasste Stunden (produktiv + Gemeinkosten)
      erfassteStunden: {
        current: erfassteStunden,
        previous: prevErfassteStunden,
        deltaPct: deltaPct(erfassteStunden, prevErfassteStunden),
      },
      // (2) Abrechenbare (produktive) Stunden
      abrechenbareStunden: {
        current: abrechenbareStunden,
        previous: prevAbrechenbareStunden,
        deltaPct: deltaPct(abrechenbareStunden, prevAbrechenbareStunden),
      },
      // (3) Produktivquote (+ Wasserkopf-Stunden)
      produktivquote: {
        current: produktivquote,
        gemeinkostenStunden,
      },
      // (4) Wachstum vs. Vormonat (produktiv + Gemeinkosten)
      wachstum: {
        produktivDeltaPct: deltaPct(abrechenbareStunden, prevAbrechenbareStunden),
        gemeinkostenDeltaPct: deltaPct(gemeinkostenStunden, prevGemeinkostenStunden),
      },
      // (5) Stundenkonto-Saldo (Auszahl-Rückstand)
      stundenkontoSaldo: Math.round(stundenkontoSaldo * 100) / 100,
      // (6) Offene Termine (dokumentiert, aber noch nicht unterschrieben)
      offeneTermine: { hours: Math.round(unsignedHours * 100) / 100, count: unsignedCount },
      // Kontext-Werte (Tabelle/Badges), nicht als eigene Kachel:
      activeEmployees: visibleRows.length,
      minijobKappung: { count: minijobKappungCount },
    },
    rows: tableRows,
  });
}));

// GET /mitarbeiterabrechnung/employee/:id — Drill-down (Termine, Aufschlüsselung, Stundenkonto)
router.get("/mitarbeiterabrechnung/employee/:id", requireWageDataAccess, asyncHandler("Mitarbeiter-Details konnten nicht geladen werden", async (req: Request, res: Response) => {
  const period = parseYearMonth(req, res);
  if (!period) return;
  const { year, month } = period;
  const employeeId = parseInt(req.params.id);
  if (isNaN(employeeId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Mitarbeiter-ID" });
    return;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const [{ rows }, { byEmployee: accounts }, closedSet] = await Promise.all([
    getEmployeePayrollRows(year, month),
    computeAccountsForMonth(year, month),
    loadClosedSet(year, month),
  ]);

  const row = rows.find(r => r.employeeId === employeeId) ?? null;
  const cells = accounts[employeeId] ?? {};
  const accountCells: AccountCell[] = HOURS_ACCOUNT_CATEGORIES.map(c => cells[c]).filter(Boolean) as AccountCell[];
  const isClosed = closedSet.has(employeeId);

  // Termine & Zeiten — dokumentierte Termine
  const apptResult = await db.execute(sql`
    SELECT
      a.id as id,
      a.date as date,
      a.scheduled_start as scheduled_start,
      a.status as status,
      c.name as customer_name,
      NULLIF(TRIM(CONCAT(p.vorname, ' ', p.nachname)), '') as prospect_name,
      COALESCE(a.travel_kilometers, 0) as travel_km,
      COALESCE(a.customer_kilometers, 0) as customer_km,
      COALESCE(a.travel_minutes, 0) as travel_minutes,
      COALESCE((
        SELECT SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))
        FROM appointment_services asvc WHERE asvc.appointment_id = a.id
      ), 0) as service_minutes
    FROM appointments a
    LEFT JOIN customers c ON c.id = a.customer_id
    LEFT JOIN prospects p ON p.id = a.prospect_id
    WHERE ${documentedSqlRaw('a')}
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ${employeeId}
    ORDER BY a.date ASC, a.scheduled_start ASC NULLS LAST
  `);
  const appointments = (apptResult.rows as any[]).map(r => ({
    id: Number(r.id),
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    scheduledStart: r.scheduled_start ?? null,
    status: r.status as string,
    customerName: resolveAppointmentPartyName(r.customer_name, r.prospect_name),
    serviceMinutes: Number(r.service_minutes) || 0,
    travelMinutes: Number(r.travel_minutes) || 0,
    travelKm: Number(r.travel_km) || 0,
    customerKm: Number(r.customer_km) || 0,
  }));

  // Manuelle Zeiteinträge (Büro/Vertrieb/Sonstiges/Urlaub/Krankheit)
  const entryResult = await db.execute(sql`
    SELECT id, entry_type, entry_date, start_time, end_time, duration_minutes, kilometers, notes
    FROM employee_time_entries
    WHERE user_id = ${employeeId}
      AND deleted_at IS NULL
      AND entry_date >= ${startDate}
      AND entry_date <= ${endDate}
    ORDER BY entry_date ASC
  `);
  const timeEntries = (entryResult.rows as any[]).map(r => ({
    id: Number(r.id),
    entryType: r.entry_type as string,
    entryDate: typeof r.entry_date === "string" ? r.entry_date : new Date(r.entry_date).toISOString().slice(0, 10),
    startTime: r.start_time ?? null,
    endTime: r.end_time ?? null,
    durationMinutes: r.duration_minutes === null ? null : Number(r.duration_minutes),
    kilometers: r.kilometers === null ? null : Number(r.kilometers),
    notes: r.notes ?? null,
  }));

  res.json({ year, month, employeeId, isClosed, row, accountCells, appointments, timeEntries });
}));

// GET /mitarbeiterabrechnung/unsigned-appointments — Liste unsignierter Termine (Sprungziel)
router.get("/mitarbeiterabrechnung/unsigned-appointments", requireWageDataAccess, asyncHandler("Nicht unterschriebene Termine konnten nicht geladen werden", async (req: Request, res: Response) => {
  const period = parseYearMonth(req, res);
  if (!period) return;
  const { year, month } = period;
  const employeeId = parseInt(req.query.employeeId as string);
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
      NULLIF(TRIM(CONCAT(p.vorname, ' ', p.nachname)), '') as prospect_name,
      COALESCE(svc_minutes.minutes, 0) as minutes
    FROM appointments a
    LEFT JOIN customers c ON c.id = a.customer_id
    LEFT JOIN prospects p ON p.id = a.prospect_id
    ${unsignedServiceMinutesLateralRaw('a', 'svc_minutes')}
    WHERE ${completedButUnsignedSqlRaw('a')}
      AND a.deleted_at IS NULL
      AND a.date >= ${startDate}
      AND a.date <= ${endDate}
      AND a.performed_by_employee_id = ${employeeId}
    ORDER BY a.date ASC, a.scheduled_start ASC NULLS LAST
  `);
  const appointments = (result.rows as any[]).map(row => ({
    id: Number(row.id),
    date: typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10),
    scheduledStart: row.scheduled_start ?? null,
    customerName: resolveAppointmentPartyName(row.customer_name, row.prospect_name),
    minutes: Number(row.minutes) || 0,
  }));

  res.json({ appointments, year, month, employeeId });
}));

// PUT /mitarbeiterabrechnung/account — Anfangsbestand/Bezahlt pflegen (audit + Sperre)
router.put("/mitarbeiterabrechnung/account", requireWageDataAccess, asyncHandler("Stundenkonto konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const parsed = upsertHoursAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message ?? "Ungültige Eingabe" });
    return;
  }

  let locked: boolean;
  try {
    ({ locked } = await upsertHoursAccount(parsed.data, req.user!.id, req.ip));
  } catch (err) {
    if (err instanceof OpeningBalanceLockedError) {
      res.status(400).json({ error: "OPENING_BALANCE_LOCKED", message: err.message });
      return;
    }
    throw err;
  }
  if (locked) {
    res.status(403).json({ error: "MONTH_CLOSED", message: "Der Monat ist abgeschlossen und kann nicht mehr bearbeitet werden." });
    return;
  }

  res.json({ success: true });
}));

export default router;
