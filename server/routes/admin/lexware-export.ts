import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { users } from "@shared/schema/users";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { companySettings } from "@shared/schema/company";
import { and, gte, lte, sql, inArray, eq } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";

const router = Router();

interface ExportRow {
  year: number;
  month: number;
  personalnummer: string;
  employeeName: string;
  lohnartnummer: string;
  lohnartLabel: string;
  value: string;
  unit: string;
}

async function buildExportData(year: number, month: number): Promise<{ rows: ExportRow[]; warnings: string[] }> {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(year, month, 0).toISOString().split("T")[0];

  const [settings] = await db.select().from(companySettings).limit(1);

  const lohnartMap = {
    alltagsbegleitung: settings?.lohnartAlltagsbegleitung || "",
    hauswirtschaft: settings?.lohnartHauswirtschaft || "",
    urlaub: settings?.lohnartUrlaub || "",
    krankheit: settings?.lohnartKrankheit || "",
  };

  const employees = await db.select({
    id: users.id,
    vorname: users.vorname,
    nachname: users.nachname,
    personalnummer: users.personalnummer,
  }).from(users).where(
    and(
      eq(users.isActive, true),
      sql`${users.personalnummer} IS NOT NULL AND ${users.personalnummer} != ''`
    )
  );

  const warnings: string[] = [];

  if (employees.length === 0) {
    return { rows: [], warnings: ["Keine Mitarbeiter mit Personalnummer gefunden."] };
  }

  const employeeIds = employees.map(e => e.id);

  const appointmentServices = await db.execute(sql`
    SELECT 
      a.performed_by_employee_id as employee_id,
      COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) as minutes,
      s.lohnart_kategorie
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

  const hoursByEmployee: Record<number, { alltagsbegleitung: number; hauswirtschaft: number }> = {};

  for (const row of appointmentServices.rows as any[]) {
    const empId = row.employee_id;
    if (!hoursByEmployee[empId]) {
      hoursByEmployee[empId] = { alltagsbegleitung: 0, hauswirtschaft: 0 };
    }
    const kategorie = row.lohnart_kategorie === "alltagsbegleitung" ? "alltagsbegleitung" : "hauswirtschaft";
    hoursByEmployee[empId][kategorie] += Number(row.minutes) || 0;
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

  if (!lohnartMap.alltagsbegleitung) warnings.push("Lohnartnummer für Alltagsbegleitung nicht konfiguriert.");
  if (!lohnartMap.hauswirtschaft) warnings.push("Lohnartnummer für Hauswirtschaft nicht konfiguriert.");
  if (!lohnartMap.urlaub) warnings.push("Lohnartnummer für Urlaub nicht konfiguriert.");
  if (!lohnartMap.krankheit) warnings.push("Lohnartnummer für Krankheit nicht konfiguriert.");

  const rows: ExportRow[] = [];

  for (const emp of employees) {
    const empHours = hoursByEmployee[emp.id] || { alltagsbegleitung: 0, hauswirtschaft: 0 };
    const ncMinutes = nonClientMinutes[emp.id] || 0;
    const empName = `${emp.nachname}, ${emp.vorname}`;

    const totalHwMinutes = empHours.hauswirtschaft + ncMinutes;
    const abMinutes = empHours.alltagsbegleitung;

    if (abMinutes > 0 && lohnartMap.alltagsbegleitung) {
      rows.push({
        year, month,
        personalnummer: emp.personalnummer!,
        employeeName: empName,
        lohnartnummer: lohnartMap.alltagsbegleitung,
        lohnartLabel: "Alltagsbegleitung",
        value: (abMinutes / 60).toFixed(2).replace(".", ","),
        unit: "Stunden",
      });
    }

    if (totalHwMinutes > 0 && lohnartMap.hauswirtschaft) {
      rows.push({
        year, month,
        personalnummer: emp.personalnummer!,
        employeeName: empName,
        lohnartnummer: lohnartMap.hauswirtschaft,
        lohnartLabel: "Hauswirtschaft",
        value: (totalHwMinutes / 60).toFixed(2).replace(".", ","),
        unit: "Stunden",
      });
    }

    const vDays = vacationDays[emp.id] || 0;
    if (vDays > 0 && lohnartMap.urlaub) {
      rows.push({
        year, month,
        personalnummer: emp.personalnummer!,
        employeeName: empName,
        lohnartnummer: lohnartMap.urlaub,
        lohnartLabel: "Urlaub",
        value: String(vDays).replace(".", ","),
        unit: "Tage",
      });
    }

    const sDays = sickDays[emp.id] || 0;
    if (sDays > 0 && lohnartMap.krankheit) {
      rows.push({
        year, month,
        personalnummer: emp.personalnummer!,
        employeeName: empName,
        lohnartnummer: lohnartMap.krankheit,
        lohnartLabel: "Krankheit",
        value: String(sDays).replace(".", ","),
        unit: "Tage",
      });
    }
  }

  rows.sort((a, b) => a.personalnummer.localeCompare(b.personalnummer) || a.lohnartnummer.localeCompare(b.lohnartnummer));

  return { rows, warnings };
}

router.get("/lexware-export", asyncHandler("Lexware-Export konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  const result = await buildExportData(year, month);
  res.json({ ...result, year, month });
}));

router.get("/lexware-export/csv", asyncHandler("CSV-Export fehlgeschlagen", async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiges Jahr oder Monat" });
    return;
  }

  const { rows } = await buildExportData(year, month);

  const csvHeader = "Jahr;Monat;Personalnummer;Lohnartnummer;Wert";
  const csvRows = rows.map(r =>
    `${r.year};${String(r.month).padStart(2, "0")};${r.personalnummer};${r.lohnartnummer};${r.value}`
  );

  const csv = [csvHeader, ...csvRows].join("\r\n");
  const filename = `Lexware_Lohnexport_${year}_${String(month).padStart(2, "0")}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + csv);
}));

export default router;
