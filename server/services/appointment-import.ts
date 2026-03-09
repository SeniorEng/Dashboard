import * as XLSX from "xlsx";
import { db } from "../lib/db";
import { customers, users, appointments, appointmentServices, services, monthlyServiceRecords } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { storage } from "../storage";

export interface ImportRow {
  rowIndex: number;
  kundeRaw: string;
  kundeId: string;
  vorname: string;
  nachname: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  kilometers: number;
  employeeName: string;
  serviceType: string;
  budgetType: string;
  pflegekasseName: string;
  pflegekasseIK: string;
  versichertennummer: string;
  pflegegrad: string;
}

export interface MatchedRow extends ImportRow {
  customerId: number | null;
  employeeId: number | null;
  serviceId: number | null;
  budgetTypeKey: string | null;
  status: "new" | "duplicate" | "error";
  errors: string[];
  existingAppointmentId: number | null;
  differences: string[];
}

export interface ImportAction {
  action: "import" | "update" | "skip";
  rowIndex: number;
  employeeIdOverride?: number;
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: { rowIndex: number; error: string }[];
}

function excelDateToISO(serial: number): string {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(epoch.getTime() + serial * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function excelTimeToHHMM(decimal: number): string {
  const totalMinutes = Math.round(decimal * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

export function parseExcelFile(buffer: Buffer): ImportRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { header: 1 }) as unknown[][];

  const expectedHeaders: Record<string, string[]> = {
    kunde: ["Kunde"],
    datum: ["Datum"],
    start: ["Start"],
    ende: ["Ende"],
    stunden: ["Stunden"],
    kilometer: ["Kilometer"],
    employee: ["Senioren Engel"],
    art: ["Art"],
    budget: ["Budget"],
    pflegekasse: ["Pflegekasse Name", "Pflegekasse", "Pflegekasse - Name"],
    ik: ["IK", "Pflegekasse - IK"],
    versichertennummer: ["Versichertennummer"],
    pflegegrad: ["Pflegegrad"],
  };

  let headerRowIndex = -1;
  const colMap: Record<string, number> = {};

  for (let ri = 0; ri < Math.min(10, raw.length); ri++) {
    const candidate = raw[ri] as unknown[];
    if (!candidate) continue;
    const hasKunde = candidate.some((c) => typeof c === "string" && c.trim() === "Kunde");
    if (hasKunde) {
      headerRowIndex = ri;
      for (const [key, variants] of Object.entries(expectedHeaders)) {
        for (const v of variants) {
          const idx = candidate.findIndex(
            (h) => typeof h === "string" && h.trim().toLowerCase() === v.toLowerCase()
          );
          if (idx >= 0) {
            colMap[key] = idx;
            break;
          }
        }
      }
      break;
    }
  }

  if (headerRowIndex === -1) {
    throw new Error("Header-Zeile mit 'Kunde' nicht gefunden in der Excel-Datei");
  }

  const rows: ImportRow[] = [];

  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (!row || row.length === 0) continue;

    const kundeRaw = String(row[colMap.kunde] ?? "").trim();
    if (!kundeRaw) continue;

    const kundeParts = kundeRaw.split("|");
    const kundeId = kundeParts[0] || "";
    const vorname = kundeParts[1] || "";
    const nachname = kundeParts[2] || "";

    const datumVal = row[colMap.datum];
    let date = "";
    if (typeof datumVal === "number") {
      date = excelDateToISO(datumVal);
    } else if (typeof datumVal === "string") {
      date = datumVal;
    }

    const startVal = row[colMap.start];
    const endVal = row[colMap.ende];
    let startTime = "";
    let endTime = "";
    if (typeof startVal === "number") {
      startTime = excelTimeToHHMM(startVal);
    }
    if (typeof endVal === "number") {
      endTime = excelTimeToHHMM(endVal);
    }

    const stunden = Number(row[colMap.stunden]) || 0;
    const km = Number(row[colMap.kilometer]) || 0;
    const employeeName = String(row[colMap.employee] ?? "").trim();
    const art = String(row[colMap.art] ?? "").trim();
    const budget = String(row[colMap.budget] ?? "").trim();
    const pflegekasse = String(row[colMap.pflegekasse] ?? "").trim();
    const ik = String(row[colMap.ik] ?? "").trim();
    const vnr = String(row[colMap.versichertennummer] ?? "").trim();
    const pg = String(row[colMap.pflegegrad] ?? "").trim();

    rows.push({
      rowIndex: i,
      kundeRaw,
      kundeId,
      vorname,
      nachname,
      date,
      startTime,
      endTime,
      durationMinutes: hoursToMinutes(stunden),
      kilometers: km,
      employeeName,
      serviceType: art,
      budgetType: budget,
      pflegekasseName: pflegekasse,
      pflegekasseIK: ik,
      versichertennummer: vnr,
      pflegegrad: pg,
    });
  }

  return rows;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function matchRows(rows: ImportRow[]): Promise<MatchedRow[]> {
  const allCustomers = await db
    .select({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname })
    .from(customers)
    .where(isNull(customers.deletedAt));

  const allUsers = await db
    .select({ id: users.id, vorname: users.vorname, nachname: users.nachname, displayName: users.displayName })
    .from(users);

  const existingAppts = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      actualStart: appointments.actualStart,
      travelKilometers: appointments.travelKilometers,
      customerKilometers: appointments.customerKilometers,
      notes: appointments.notes,
    })
    .from(appointments)
    .where(
      and(
        isNull(appointments.deletedAt),
        eq(appointments.appointmentType, "Kundentermin")
      )
    );

  const customerMap = new Map<string, number>();
  for (const c of allCustomers) {
    if (c.vorname && c.nachname) {
      const key = normalizeForMatch(`${c.vorname} ${c.nachname}`);
      customerMap.set(key, c.id);
    }
  }

  const employeeMap = new Map<string, number>();
  for (const u of allUsers) {
    if (u.displayName) {
      employeeMap.set(normalizeForMatch(u.displayName), u.id);
    }
    if (u.vorname && u.nachname) {
      employeeMap.set(normalizeForMatch(`${u.vorname} ${u.nachname}`), u.id);
    }
  }

  const allServices = await db
    .select({ id: services.id, code: services.code })
    .from(services);

  const serviceMap: Record<string, number> = {};
  for (const s of allServices) {
    if (s.code) serviceMap[s.code.toLowerCase()] = s.id;
  }

  const budgetMap: Record<string, string> = {
    entlastungsleistung: "entlastungsbetrag_45b",
    "entlastungsbetrag": "entlastungsbetrag_45b",
    "verhinderungs-/kurzzeitpflege": "ersatzpflege_39_42a",
    "verhinderungspflege": "ersatzpflege_39_42a",
    "verhinderungs- / kurzzeitpflege": "ersatzpflege_39_42a",
    "verhinderungs-/ kurzzeitpflege": "ersatzpflege_39_42a",
  };

  const apptIndex = new Map<string, typeof existingAppts[0]>();
  for (const a of existingAppts) {
    const dateStr = typeof a.date === "string" ? a.date : String(a.date);
    const startStr = a.scheduledStart || a.actualStart || "";
    const key = `${a.customerId}|${dateStr}|${startStr?.substring(0, 5)}`;
    apptIndex.set(key, a);
  }

  return rows.map((row) => {
    const errors: string[] = [];
    const differences: string[] = [];

    const customerKey = normalizeForMatch(`${row.vorname} ${row.nachname}`);
    const customerId = customerMap.get(customerKey) ?? null;
    if (!customerId) {
      errors.push(`Kunde nicht gefunden: ${row.vorname} ${row.nachname}`);
    }

    const employeeKey = normalizeForMatch(row.employeeName);
    const employeeId = employeeMap.get(employeeKey) ?? null;
    if (!employeeId) {
      errors.push(`Mitarbeiter nicht gefunden: ${row.employeeName}`);
    }

    const serviceKey = row.serviceType.toLowerCase();
    const serviceId = serviceMap[serviceKey] ?? null;
    if (!serviceId) {
      errors.push(`Service unbekannt: ${row.serviceType}`);
    }

    const budgetKey = row.budgetType.toLowerCase();
    const budgetTypeKey = budgetMap[budgetKey] ?? null;
    if (!budgetTypeKey) {
      errors.push(`Budget-Typ unbekannt: ${row.budgetType}`);
    }

    if (!row.date) {
      errors.push("Datum fehlt");
    }
    if (!row.startTime) {
      errors.push("Startzeit fehlt");
    }

    let status: MatchedRow["status"] = errors.length > 0 ? "error" : "new";
    let existingAppointmentId: number | null = null;

    if (customerId && row.date && row.startTime) {
      const dupKey = `${customerId}|${row.date}|${row.startTime}`;
      const existing = apptIndex.get(dupKey);
      if (existing) {
        status = "duplicate";
        existingAppointmentId = existing.id;
        const existingKm = existing.travelKilometers ?? 0;
        if (existingKm !== row.kilometers) {
          differences.push(`Kilometer: DB=${existingKm} → Excel=${row.kilometers}`);
        }
      }
    }

    return {
      ...row,
      customerId,
      employeeId,
      serviceId,
      budgetTypeKey,
      status,
      errors,
      existingAppointmentId,
      differences,
    };
  });
}

export async function executeImport(
  matchedRows: MatchedRow[],
  actions: ImportAction[],
  userId: number
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };

  const actionMap = new Map<number, ImportAction>();
  for (const a of actions) {
    actionMap.set(a.rowIndex, a);
  }

  for (const row of matchedRows) {
    const action = actionMap.get(row.rowIndex);
    if (!action || action.action === "skip") {
      result.skipped++;
      continue;
    }

    const effectiveEmployeeId = action.employeeIdOverride ?? row.employeeId;

    if (action.action === "import") {
      if (!row.customerId || !effectiveEmployeeId || !row.serviceId) {
        result.errors.push({ rowIndex: row.rowIndex, error: "Fehlende IDs für Import" });
        continue;
      }

      try {
        await db.transaction(async (tx) => {
          const scheduledEnd = row.endTime || row.startTime;

          const [appt] = await tx
            .insert(appointments)
            .values({
              customerId: row.customerId!,
              createdByUserId: userId,
              assignedEmployeeId: effectiveEmployeeId,
              performedByEmployeeId: effectiveEmployeeId,
              appointmentType: "Kundentermin",
              date: row.date,
              scheduledStart: row.startTime,
              scheduledEnd: scheduledEnd,
              durationPromised: row.durationMinutes,
              status: "completed",
              actualStart: row.startTime,
              actualEnd: row.endTime || null,
              travelOriginType: "home",
              travelKilometers: row.kilometers,
              travelMinutes: 0,
              customerKilometers: 0,
              notes: "Import aus Altdaten",
              signedAt: new Date(),
              signedByUserId: userId,
            })
            .returning();

          await tx.insert(appointmentServices).values({
            appointmentId: appt.id,
            serviceId: row.serviceId!,
            plannedDurationMinutes: row.durationMinutes,
            actualDurationMinutes: row.durationMinutes,
            details: `Import: ${row.serviceType}`,
          });

          const isHauswirtschaft = row.serviceType.toLowerCase() === "hauswirtschaft";
          const hwMinutes = isHauswirtschaft ? row.durationMinutes : 0;
          const abMinutes = isHauswirtschaft ? 0 : row.durationMinutes;

          await budgetLedgerStorage.createConsumptionTransaction(
            {
              customerId: row.customerId!,
              appointmentId: appt.id,
              transactionDate: row.date,
              hauswirtschaftMinutes: hwMinutes,
              alltagsbegleitungMinutes: abMinutes,
              travelKilometers: row.kilometers,
              customerKilometers: 0,
              userId,
            },
            tx
          );
        });
        result.imported++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ rowIndex: row.rowIndex, error: msg });
      }
    }

    if (action.action === "update" && row.existingAppointmentId) {
      try {
        await db
          .update(appointments)
          .set({
            travelKilometers: row.kilometers,
            notes: "Import-Update aus Altdaten",
          })
          .where(eq(appointments.id, row.existingAppointmentId));
        result.updated++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ rowIndex: row.rowIndex, error: msg });
      }
    }
  }

  return result;
}

export async function createServiceRecordsForImported(userId: number): Promise<{
  created: number;
  errors: { key: string; error: string }[];
}> {
  const importedAppts = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      performedByEmployeeId: appointments.performedByEmployeeId,
      date: appointments.date,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.notes, "Import aus Altdaten"),
        eq(appointments.status, "completed"),
        isNull(appointments.deletedAt)
      )
    );

  const grouping = new Map<string, { customerId: number; employeeId: number; year: number; month: number; appointmentIds: number[] }>();

  for (const a of importedAppts) {
    if (!a.performedByEmployeeId) continue;
    const dateStr = typeof a.date === "string" ? a.date : String(a.date);
    const parts = dateStr.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const key = `${a.customerId}|${a.performedByEmployeeId}|${year}|${month}`;

    if (!grouping.has(key)) {
      grouping.set(key, {
        customerId: a.customerId,
        employeeId: a.performedByEmployeeId,
        year,
        month,
        appointmentIds: [],
      });
    }
    grouping.get(key)!.appointmentIds.push(a.id);
  }

  let created = 0;
  const errors: { key: string; error: string }[] = [];

  for (const [key, group] of grouping) {
    try {
      const existing = await storage.getServiceRecordsForCustomer(group.customerId);
      const alreadyExists = existing.some(
        (sr) => sr.employeeId === group.employeeId && sr.year === group.year && sr.month === group.month
      );
      if (alreadyExists) continue;

      const sr = await storage.createServiceRecord({
        customerId: group.customerId,
        employeeId: group.employeeId,
        year: group.year,
        month: group.month,
      });

      await storage.addAppointmentsToServiceRecord(sr.id, group.appointmentIds);

      await db
        .update(monthlyServiceRecords)
        .set({ status: "completed" })
        .where(eq(monthlyServiceRecords.id, sr.id));

      created++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ key, error: msg });
    }
  }

  return { created, errors };
}
