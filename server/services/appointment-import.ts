import ExcelJS from "exceljs";
import { db } from "../lib/db";
import { customers, users, appointments, appointmentServices, services, monthlyServiceRecords } from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { storage } from "../storage";
import { calculateAppointmentCost } from "../storage/budget/appointment-cost-calculator";
import { getAvailableForDate } from "../storage/budget/import-availability";
import { isWeekend } from "@shared/utils/datetime";
import { appointmentsRepo, customersRepo } from "../repos";

interface ImportRow {
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

interface BudgetTrimInfo {
  originalMinutes: number;
  trimmedMinutes: number;
  reason: string;
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
  budgetTrimInfo: BudgetTrimInfo | null;
}

interface ImportAction {
  action: "import" | "update" | "skip";
  rowIndex: number;
  employeeIdOverride?: number;
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  trimmed: number;
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

function dateToISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateToHHMM(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function unwrapCellValue(val: unknown): unknown {
  if (val && typeof val === "object" && "result" in (val as Record<string, unknown>)) {
    return (val as { result: unknown }).result;
  }
  if (val && typeof val === "object" && "text" in (val as Record<string, unknown>)) {
    const t = (val as { text: unknown }).text;
    if (typeof t === "string") return t;
    if (Array.isArray(t)) {
      return t
        .map((p) => (typeof p === "object" && p !== null && "text" in p ? (p as { text: string }).text : String(p)))
        .join("");
    }
  }
  if (val && typeof val === "object" && "richText" in (val as Record<string, unknown>)) {
    const rt = (val as { richText: Array<{ text: string }> }).richText;
    return rt.map((p) => p.text).join("");
  }
  if (val && typeof val === "object" && "hyperlink" in (val as Record<string, unknown>)) {
    return (val as { text?: string }).text ?? "";
  }
  return val;
}

export async function parseExcelFile(buffer: Buffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("Keine Arbeitsblätter in der Excel-Datei gefunden");
  }

  const raw: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as unknown[];
    const arr: unknown[] = [];
    for (let c = 1; c < values.length; c++) {
      arr.push(unwrapCellValue(values[c]));
    }
    raw.push(arr);
  });

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
    const candidate = raw[ri];
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
    const row = raw[i];
    if (!row || row.length === 0) continue;

    const kundeRaw = String(row[colMap.kunde] ?? "").trim();
    if (!kundeRaw) continue;

    const kundeParts = kundeRaw.split("|");
    const kundeId = kundeParts[0] || "";
    const vorname = kundeParts[1] || "";
    const nachname = kundeParts[2] || "";

    const datumVal = row[colMap.datum];
    let date = "";
    if (datumVal instanceof Date) {
      date = dateToISO(datumVal);
    } else if (typeof datumVal === "number") {
      date = excelDateToISO(datumVal);
    } else if (typeof datumVal === "string") {
      date = datumVal;
    }

    const startVal = row[colMap.start];
    const endVal = row[colMap.ende];
    let startTime = "";
    let endTime = "";
    if (startVal instanceof Date) {
      startTime = dateToHHMM(startVal);
    } else if (typeof startVal === "number") {
      startTime = excelTimeToHHMM(startVal);
    }
    if (endVal instanceof Date) {
      endTime = dateToHHMM(endVal);
    } else if (typeof endVal === "number") {
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
  const allCustomers = await customersRepo.selectColumnsFrom({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname }, db)
    .orderBy(customers.id);

  const allUsers = await db
    .select({ id: users.id, vorname: users.vorname, nachname: users.nachname, displayName: users.displayName })
    .from(users);

  const existingAppts = await appointmentsRepo.selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      actualStart: appointments.actualStart,
      travelKilometers: appointments.travelKilometers,
      customerKilometers: appointments.customerKilometers,
      notes: appointments.notes,
    }, db)
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
      if (!customerMap.has(key)) {
        customerMap.set(key, c.id);
      }
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
    } else if (isWeekend(row.date)) {
      errors.push("Termine an Samstagen oder Sonntagen sind nicht erlaubt");
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
      budgetTrimInfo: null,
    };
  });
}

async function getAvailableBudgetCentsForDate(customerId: number, transactionDate: string): Promise<number> {
  const result = await getAvailableForDate(customerId, transactionDate);
  return result.totalCents;
}

async function computeVerifiedTrimmedMinutes(
  customerId: number,
  serviceType: string,
  originalMinutes: number,
  kilometers: number,
  date: string,
  availableCents: number,
): Promise<number> {
  const isHauswirtschaft = serviceType.toLowerCase() === "hauswirtschaft";

  const fullCosts = await calculateAppointmentCost({
    customerId,
    hauswirtschaftMinutes: isHauswirtschaft ? originalMinutes : 0,
    alltagsbegleitungMinutes: isHauswirtschaft ? 0 : originalMinutes,
    travelKilometers: kilometers,
    customerKilometers: 0,
    date,
  });

  const travelCents = fullCosts.travelCents;
  const serviceCents = fullCosts.hauswirtschaftCents + fullCosts.alltagsbegleitungCents;
  const budgetForService = Math.max(0, availableCents - travelCents);

  let estimate: number;
  if (serviceCents <= 0 || budgetForService <= 0) {
    estimate = 0;
  } else {
    estimate = Math.min(Math.floor(originalMinutes * budgetForService / serviceCents), originalMinutes);
  }

  for (let candidate = estimate; candidate >= 0; candidate--) {
    const costs = await calculateAppointmentCost({
      customerId,
      hauswirtschaftMinutes: isHauswirtschaft ? candidate : 0,
      alltagsbegleitungMinutes: isHauswirtschaft ? 0 : candidate,
      travelKilometers: kilometers,
      customerKilometers: 0,
      date,
    });
    if (costs.totalCents <= availableCents) {
      return candidate;
    }
  }

  return 0;
}

export async function enrichWithBudgetInfo(rows: MatchedRow[]): Promise<void> {
  const customerIds = [...new Set(
    rows.filter(r => r.customerId && r.status === "new").map(r => r.customerId!)
  )];

  const privatePaymentMap = new Map<number, boolean>();
  for (const customerId of customerIds) {
    const [customer] = await customersRepo.selectColumnsFrom({ acceptsPrivatePayment: customers.acceptsPrivatePayment }, db)
      .where(eq(customers.id, customerId))
      .limit(1);
    privatePaymentMap.set(customerId, customer?.acceptsPrivatePayment ?? false);
  }

  for (const row of rows) {
    row.budgetTrimInfo = null;
    if (!row.customerId || row.status !== "new") continue;
    if (privatePaymentMap.get(row.customerId)) continue;

    try {
      const isHauswirtschaft = row.serviceType.toLowerCase() === "hauswirtschaft";
      const costs = await calculateAppointmentCost({
        customerId: row.customerId,
        hauswirtschaftMinutes: isHauswirtschaft ? row.durationMinutes : 0,
        alltagsbegleitungMinutes: isHauswirtschaft ? 0 : row.durationMinutes,
        travelKilometers: row.kilometers,
        customerKilometers: 0,
        date: row.date,
      });

      const availableCents = await getAvailableBudgetCentsForDate(row.customerId, row.date);

      if (costs.totalCents > availableCents) {
        const trimmedMinutes = await computeVerifiedTrimmedMinutes(
          row.customerId, row.serviceType, row.durationMinutes,
          row.kilometers, row.date, availableCents,
        );

        row.budgetTrimInfo = {
          originalMinutes: row.durationMinutes,
          trimmedMinutes,
          reason: trimmedMinutes > 0
            ? `Budget reicht nur für ${trimmedMinutes} Min`
            : `Budget erschöpft — 0 Leistungsminuten`,
        };
      }
    } catch {
    }
  }
}

async function importSingleRow(
  row: MatchedRow,
  employeeId: number,
  userId: number,
  durationMinutes: number,
  notes: string,
): Promise<void> {
  if (isWeekend(row.date)) {
    throw new Error("Termine an Samstagen oder Sonntagen sind nicht erlaubt");
  }
  await db.transaction(async (tx) => {
    const scheduledEnd = row.endTime || row.startTime;

    const [appt] = await tx
      .insert(appointments)
      .values({
        customerId: row.customerId!,
        createdByUserId: userId,
        assignedEmployeeId: employeeId,
        performedByEmployeeId: employeeId,
        appointmentType: "Kundentermin",
        date: row.date,
        scheduledStart: row.startTime,
        scheduledEnd: scheduledEnd,
        durationPromised: durationMinutes,
        status: "completed",
        actualStart: row.startTime,
        actualEnd: row.endTime || null,
        travelOriginType: "home",
        travelKilometers: row.kilometers,
        travelMinutes: 0,
        customerKilometers: 0,
        notes,
        signedAt: new Date(),
        signedByUserId: userId,
      })
      .returning();

    await tx.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: row.serviceId!,
      plannedDurationMinutes: durationMinutes,
      actualDurationMinutes: durationMinutes,
      details: `Import: ${row.serviceType}`,
    });

    const isHauswirtschaft = row.serviceType.toLowerCase() === "hauswirtschaft";
    const hwMinutes = isHauswirtschaft ? durationMinutes : 0;
    const abMinutes = isHauswirtschaft ? 0 : durationMinutes;

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
}

export async function executeImport(
  matchedRows: MatchedRow[],
  actions: ImportAction[],
  userId: number
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, trimmed: 0, errors: [] };

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
        await importSingleRow(row, effectiveEmployeeId, userId, row.durationMinutes, "Import aus Altdaten");
        result.imported++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("Budget reicht nicht")) {
          try {
            const availableCents = await getAvailableBudgetCentsForDate(row.customerId, row.date);
            const trimmedMinutes = await computeVerifiedTrimmedMinutes(
              row.customerId, row.serviceType, row.durationMinutes,
              row.kilometers, row.date, availableCents,
            );

            const trimNote = trimmedMinutes > 0
              ? `Import aus Altdaten — Budget gekürzt: ${row.durationMinutes} → ${trimmedMinutes} Min`
              : `Import aus Altdaten — Budget erschöpft: ${row.durationMinutes} → 0 Min`;
            await importSingleRow(row, effectiveEmployeeId, userId, trimmedMinutes, trimNote);
            result.imported++;
            result.trimmed++;
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            result.errors.push({ rowIndex: row.rowIndex, error: retryMsg });
          }
        } else {
          result.errors.push({ rowIndex: row.rowIndex, error: msg });
        }
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
  const importedAppts = await appointmentsRepo.selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
      performedByEmployeeId: appointments.performedByEmployeeId,
      date: appointments.date,
    }, db)
    .where(
      and(
        sql`${appointments.notes} LIKE 'Import aus Altdaten%'`,
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
        customerId: a.customerId!,
        employeeId: a.performedByEmployeeId!,
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
        recordType: "monthly",
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
