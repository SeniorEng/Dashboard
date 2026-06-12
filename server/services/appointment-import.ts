import ExcelJS from "exceljs";
import { db } from "../lib/db";
import { customers, users, appointments, appointmentServices, services, monthlyServiceRecords, budgetTransactions } from "@shared/schema";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { storage } from "../storage";
import { calculateAppointmentCost } from "../storage/budget/appointment-cost-calculator";
import { getAvailableForDate } from "../storage/budget/import-availability";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { auditService } from "./audit";
import { isWeekend } from "@shared/utils/datetime";
import { parseGermanDecimal } from "@shared/utils/parse-german-decimal";
import { appointmentsRepo, customersRepo } from "../repos";
import { excelServiceArtToCategory, isHauswirtschaftArt } from "@shared/domain/excel-service-art";
import { computeLastExcelMonth, isBeyondCutoff, type ExcelCutoff } from "@shared/domain/import-cutoff";
import { isDocumentationOnlyImport } from "@shared/domain/import-documentation-only";

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

/**
 * Task #647 — Strukturierter Diff zwischen Excel-Zeile und vorhandenem
 * Termin (für Duplikate). Wird zusätzlich zu `differences` (Strings)
 * geliefert, damit die UI Mismatches in einzelnen Spalten/Badges
 * darstellen kann — insb. Service-Art-Mismatches.
 */
export interface ImportRowDiff {
  serviceCode?: { db: string | null; excel: string };
  durationMinutes?: { db: number; excel: number };
  endTime?: { db: string; excel: string };
  assignedEmployee?: { dbId: number | null; dbName: string | null; excelId: number | null; excelName: string };
  kilometers?: { db: number; excel: number };
}

export interface MatchedRow extends ImportRow {
  customerId: number | null;
  employeeId: number | null;
  serviceId: number | null;
  budgetTypeKey: string | null;
  status: "new" | "duplicate" | "upgrade" | "beyond_cutoff" | "error";
  errors: string[];
  existingAppointmentId: number | null;
  differences: string[];
  budgetTrimInfo: BudgetTrimInfo | null;
  /** Task #647: strukturierter Diff für die Vorschau-UI. */
  diff: ImportRowDiff | null;
  /**
   * Task #1243: Vorjahres-Termin eines Pflegekassen-Kunden ohne
   * Privatzahlung → wird nur als Dokumentation (ohne Budgetverbrauch)
   * importiert. SSoT: `isDocumentationOnlyImport`.
   */
  documentationOnly?: boolean;
}

interface ImportAction {
  action: "import" | "update" | "upgrade" | "skip";
  rowIndex: number;
  employeeIdOverride?: number;
}

interface ImportResult {
  imported: number;
  updated: number;
  /** Task #708: upgegradete bisher nur geplante Termine. */
  upgraded: number;
  skipped: number;
  trimmed: number;
  /** Task #708: durch Cutoff-Schutz blockierte Mutationen. */
  cutoffProtected: number;
  /**
   * Task #1243: Als reine Dokumentation (ohne Budgetverbrauch) importierte
   * Vorjahres-Termine. SSoT: `isDocumentationOnlyImport`.
   */
  documentationOnly: number;
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

export function excelTimeToHHMM(decimal: number): string {
  // Task #997 (#5): Mitternacht normalisieren. Ein Excel-Zeitserial von genau
  // 1.0 (oder Rundung darauf) ergäbe sonst "24:00" — keine gültige Uhrzeit und
  // PostgreSQL-`time`-untauglich. `% 1440` faltet 24:00 → 00:00.
  const totalMinutes = Math.round(decimal * 24 * 60) % 1440;
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

    // Task #819 (GoBD): Dezimal-Spalten MÜSSEN über parseGermanDecimal laufen.
    // `Number("10,9")` ergibt NaN (→ 0) und würde bei text-formatierten Excel-
    // Zellen alle Nachkommastellen still auf 0 runden — eine GoBD-widrige stille
    // Datenverfälschung beim Import. Fitness-Function:
    // tests/architecture/no-bare-number-in-import.test.ts.
    const stunden = parseGermanDecimal(row[colMap.stunden]);
    const km = parseGermanDecimal(row[colMap.kilometer]);
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
      scheduledEnd: appointments.scheduledEnd,
      actualStart: appointments.actualStart,
      actualEnd: appointments.actualEnd,
      travelKilometers: appointments.travelKilometers,
      customerKilometers: appointments.customerKilometers,
      assignedEmployeeId: appointments.assignedEmployeeId,
      notes: appointments.notes,
      status: appointments.status,
      signedAt: appointments.signedAt,
    }, db)
    .where(
      and(
        isNull(appointments.deletedAt),
        eq(appointments.appointmentType, "Kundentermin")
      )
    );

  // Task #647: für Duplikate brauchen wir Service-Art + Soll-Dauer aus
  // `appointment_services`. Eine Bulk-Query je Termin-Set + Map.
  const existingApptIds = existingAppts.map((a) => a.id);
  const apptServiceRows = existingApptIds.length > 0
    ? await db
        .select({
          appointmentId: appointmentServices.appointmentId,
          serviceId: appointmentServices.serviceId,
          serviceCode: services.code,
          kategorie: services.lohnartKategorie,
          actual: appointmentServices.actualDurationMinutes,
          planned: appointmentServices.plannedDurationMinutes,
        })
        .from(appointmentServices)
        .innerJoin(services, eq(appointmentServices.serviceId, services.id))
        .where(inArray(appointmentServices.appointmentId, existingApptIds))
    : [];
  const apptServicesMap = new Map<number, typeof apptServiceRows>();
  for (const r of apptServiceRows) {
    let bucket = apptServicesMap.get(r.appointmentId);
    if (!bucket) {
      bucket = [];
      apptServicesMap.set(r.appointmentId, bucket);
    }
    bucket.push(r);
  }

  const userNameById = new Map<number, string>();
  for (const u of allUsers) {
    userNameById.set(
      u.id,
      u.displayName ?? `${u.vorname ?? ""} ${u.nachname ?? ""}`.trim(),
    );
  }

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

  // Task #708: Cutoff = letzter Tag des größten YYYY-MM aus der Excel-Datei.
  // Termine NACH dem Cutoff (z. B. Folgemonat) dürfen vom Re-Import
  // niemals angefasst werden, weil sie in der Excel-Quelle noch nicht
  // dokumentiert sind — sonst löscht ein Re-Import frisch geplante,
  // noch nicht durchgeführte Termine.
  const cutoff = computeLastExcelMonth(rows.map((r) => r.date));

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

    // Task #708: Service-Lookup geht über die zentrale Excel-Art-Map,
    // damit auch Kürzel ("HW"/"AB") und gemischte Schreibweisen einen
    // serviceId-Treffer ergeben. Fallback auf den rohen Lowercase-Code
    // erhält Rückwärtskompatibilität für nicht-Art-Spalten.
    const centralServiceKey = excelServiceArtToCategory(row.serviceType);
    const serviceKey = centralServiceKey ?? row.serviceType.toLowerCase();
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
    let diff: ImportRowDiff | null = null;

    if (customerId && row.date && row.startTime) {
      const dupKey = `${customerId}|${row.date}|${row.startTime}`;
      const existing = apptIndex.get(dupKey);
      if (existing) {
        // Task #708: Geplante (`scheduled`) und nicht-unterschriebene
        // Termine sind keine echten Duplikate — die Excel-Doku ist die
        // verbindliche Quelle und hebt sie via "upgrade"-Aktion auf
        // `completed` an. Bereits unterschriebene oder anders abgeschlossene
        // Termine bleiben "duplicate" (nur Felder-Drift möglich).
        const isUpgradable =
          existing.status === "scheduled" && existing.signedAt == null;
        status = isUpgradable ? "upgrade" : "duplicate";
        existingAppointmentId = existing.id;
        diff = {};

        // Kilometer
        const existingKm = existing.travelKilometers ?? 0;
        if (Math.abs(existingKm - row.kilometers) > 0.001) {
          differences.push(`Kilometer: DB=${existingKm} → Excel=${row.kilometers}`);
          diff.kilometers = { db: existingKm, excel: row.kilometers };
        }

        // Service-Art (Excel: "Hauswirtschaft"/"Alltagsbegleitung" → code-lower)
        const excelCat = excelServiceArtToCategory(row.serviceType);
        const excelServiceCode = excelCat ?? row.serviceType.toLowerCase();
        const apptSvcs = apptServicesMap.get(existing.id) ?? [];
        // Bei mehreren Service-Zeilen: kategorisch dominierende Art heranziehen
        let dbServiceCode: string | null = null;
        if (apptSvcs.length === 1) {
          dbServiceCode = apptSvcs[0].serviceCode ?? null;
        } else if (apptSvcs.length > 1) {
          let hwM = 0;
          let abM = 0;
          for (const s of apptSvcs) {
            const m = s.actual ?? s.planned ?? 0;
            if (s.kategorie === "hauswirtschaft") hwM += m;
            else if (s.kategorie === "alltagsbegleitung") abM += m;
          }
          dbServiceCode = hwM >= abM ? "hauswirtschaft" : "alltagsbegleitung";
        }
        if (dbServiceCode && excelServiceCode && dbServiceCode !== excelServiceCode) {
          differences.push(`Art: DB=${dbServiceCode} → Excel=${excelServiceCode}`);
          diff.serviceCode = { db: dbServiceCode, excel: excelServiceCode };
        }

        // Dauer (Σ actual ?? planned)
        const dbDuration = apptSvcs.reduce(
          (s, r2) => s + (r2.actual ?? r2.planned ?? 0),
          0,
        );
        if (dbDuration !== row.durationMinutes) {
          differences.push(`Dauer: DB=${dbDuration}min → Excel=${row.durationMinutes}min`);
          diff.durationMinutes = { db: dbDuration, excel: row.durationMinutes };
        }

        // End-Zeit
        const dbEnd = (existing.scheduledEnd || existing.actualEnd || "").substring(0, 5);
        if (row.endTime && dbEnd && dbEnd !== row.endTime) {
          differences.push(`Ende: DB=${dbEnd} → Excel=${row.endTime}`);
          diff.endTime = { db: dbEnd, excel: row.endTime };
        }

        // Mitarbeiter
        const dbEmpId = existing.assignedEmployeeId ?? null;
        const dbEmpName = dbEmpId != null ? (userNameById.get(dbEmpId) ?? null) : null;
        if (employeeId != null && dbEmpId !== employeeId) {
          differences.push(`Mitarbeiter: DB=${dbEmpName ?? dbEmpId ?? "?"} → Excel=${row.employeeName}`);
          diff.assignedEmployee = {
            dbId: dbEmpId,
            dbName: dbEmpName,
            excelId: employeeId,
            excelName: row.employeeName,
          };
        }

        if (Object.keys(diff).length === 0) diff = null;
      }
    }

    // Task #708: Cutoff-Schutz nach Status-Bestimmung — egal ob `new`,
    // `duplicate` oder `upgrade`: Termine jenseits des Excel-Cutoffs
    // werden nicht angefasst. Fehler-Zeilen bleiben Fehler (man muss sie
    // sehen können). Reihenfolge in der UI: cutoff überlagert alles
    // außer error.
    if (status !== "error" && row.date && cutoff && isBeyondCutoff(row.date, cutoff)) {
      status = "beyond_cutoff";
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
      diff,
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
  const isHauswirtschaft = isHauswirtschaftArt(serviceType);

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

/**
 * SSoT für "akzeptiert dieser Kunde Privatzahlung?" — wird sowohl von der
 * Vorschau (`enrichWithBudgetInfo`) als auch von der Ausführung
 * (`executeImport`) genutzt, damit Trim-/Dokumentations-Entscheidung in beiden
 * Pfaden identisch ausfällt.
 *
 * Task #588: Selbstzahler zahlen per Definition immer privat — der Import darf
 * sie deshalb NICHT als "Budget reicht nicht"-Fall behandeln, genauso wenig wie
 * der interaktive Doku-Pfad in der Consumption-Engine.
 */
async function loadPrivatePaymentAllowed(
  customerIds: number[],
): Promise<Map<number, boolean>> {
  const privatePaymentMap = new Map<number, boolean>();
  for (const customerId of customerIds) {
    const [customer] = await customersRepo
      .selectColumnsFrom(
        {
          acceptsPrivatePayment: customers.acceptsPrivatePayment,
          billingType: customers.billingType,
        },
        db,
      )
      .where(eq(customers.id, customerId))
      .limit(1);
    const isPrivateAllowed =
      (customer?.acceptsPrivatePayment ?? false) ||
      customer?.billingType === "selbstzahler";
    privatePaymentMap.set(customerId, isPrivateAllowed);
  }
  return privatePaymentMap;
}

export async function enrichWithBudgetInfo(rows: MatchedRow[]): Promise<void> {
  const customerIds = [...new Set(
    rows.filter(r => r.customerId && r.status === "new").map(r => r.customerId!)
  )];

  const privatePaymentMap = await loadPrivatePaymentAllowed(customerIds);

  for (const row of rows) {
    row.budgetTrimInfo = null;
    row.documentationOnly = false;
    if (!row.customerId || row.status !== "new") continue;

    // Task #1243: Vorjahres-Termine echter Pflegekassen-Kunden werden nur als
    // Dokumentation importiert (kein Budgetverbrauch) — also auch keine
    // Kürzungs-Berechnung. SSoT: `isDocumentationOnlyImport`.
    if (
      isDocumentationOnlyImport({
        date: row.date,
        isPrivatePaymentAllowed: privatePaymentMap.get(row.customerId) ?? false,
      })
    ) {
      row.documentationOnly = true;
      continue;
    }

    if (privatePaymentMap.get(row.customerId)) continue;

    try {
      const isHauswirtschaft = isHauswirtschaftArt(row.serviceType);
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
  importBatchId?: number | null,
  /**
   * Task #1243: Bei reinen Dokumentations-Importen (Vorjahres-Termin echter
   * Pflegekasse) wird der Termin angelegt, aber KEINE Consumption gebucht —
   * für solche Daten ist das gesetzliche Budget = 0, eine Buchung würde immer
   * hart blocken.
   */
  skipBudgetConsumption = false,
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
        importBatchId: importBatchId ?? null,
      })
      .returning();

    await tx.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: row.serviceId!,
      plannedDurationMinutes: durationMinutes,
      actualDurationMinutes: durationMinutes,
      details: `Import: ${row.serviceType}`,
    });

    // Task #1243: Dokumentations-Import legt nur den Termin-Datensatz an, keine
    // Budget-Buchung — daher hier (und beim Batch-Link, der ohnehin nichts
    // träfe) früh aussteigen.
    if (skipBudgetConsumption) {
      return;
    }

    const isHauswirtschaft = isHauswirtschaftArt(row.serviceType);
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

    // Task #819: Alle für diesen Termin erzeugten Budget-Buchungen
    // (Cascading über mehrere Töpfe möglich) mit dem Import-Batch verknüpfen.
    if (importBatchId != null) {
      await tx
        .update(budgetTransactions)
        .set({ importBatchId })
        .where(eq(budgetTransactions.appointmentId, appt.id));
    }
  });
}

export async function executeImport(
  matchedRows: MatchedRow[],
  actions: ImportAction[],
  userId: number,
  /**
   * Task #708: Optionaler expliziter Excel-Cutoff. Falls gesetzt, wird er
   * als harte obere Grenze über `matchedRows` hinweg verwendet —
   * unabhängig davon, ob der Client zusätzliche Zeilen jenseits des
   * ursprünglichen Excel-Bereichs einschmuggelt. Fallback: aus
   * `matchedRows.date` ableiten (legacy Default).
   */
  excelCutoff?: ExcelCutoff | null,
  /** Task #819: Verknüpft alle erzeugten/aktualisierten Datensätze mit dem Import-Batch. */
  importBatchId?: number | null,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, updated: 0, upgraded: 0, skipped: 0, trimmed: 0, cutoffProtected: 0, documentationOnly: 0, errors: [] };

  const actionMap = new Map<number, ImportAction>();
  for (const a of actions) {
    actionMap.set(a.rowIndex, a);
  }

  // Task #1243: Privatzahlungs-Status aller betroffenen Kunden EINMAL vorab
  // laden (gleiche SSoT wie die Vorschau), um pro Zeile zu entscheiden, ob sie
  // nur als Dokumentation (ohne Budgetverbrauch) importiert wird.
  const privatePaymentMap = await loadPrivatePaymentAllowed([
    ...new Set(matchedRows.filter((r) => r.customerId).map((r) => r.customerId!)),
  ]);
  const isDocOnlyRow = (row: MatchedRow): boolean =>
    row.customerId != null &&
    isDocumentationOnlyImport({
      date: row.date,
      isPrivatePaymentAllowed: privatePaymentMap.get(row.customerId) ?? false,
    });

  // Task #708: Defense-in-depth — Cutoff aus den preview-matched Zeilen
  // erneut berechnen und JEDE Mutation (Import/Update/Upgrade) jenseits
  // davon hart blockieren, selbst wenn der Client ein passendes Action-
  // Objekt schickt. Die Zeilen sind in `matchRows` schon mit
  // `beyond_cutoff` getaggt, aber ein manipulierter Client könnte den
  // Status umgehen. Wenn `excelCutoff` explizit übergeben wurde, hat das
  // Vorrang — sonst Fallback auf Ableitung aus den matchedRows selbst.
  const executeCutoff =
    excelCutoff !== undefined
      ? excelCutoff
      : computeLastExcelMonth(matchedRows.map((r) => r.date));

  for (const row of matchedRows) {
    const action = actionMap.get(row.rowIndex);
    if (!action || action.action === "skip") {
      result.skipped++;
      continue;
    }

    // Task #708: Cutoff-Schutz — Termine nach Cutoff werden NIE angefasst.
    if (
      (row.status === "beyond_cutoff") ||
      (executeCutoff && row.date && isBeyondCutoff(row.date, executeCutoff))
    ) {
      result.cutoffProtected++;
      continue;
    }

    const effectiveEmployeeId = action.employeeIdOverride ?? row.employeeId;

    if (action.action === "import") {
      if (!row.customerId || !effectiveEmployeeId || !row.serviceId) {
        result.errors.push({ rowIndex: row.rowIndex, error: "Fehlende IDs für Import" });
        continue;
      }

      // Task #1243: Vorjahres-Termin echter Pflegekasse → nur Dokumentation,
      // kein Budgetverbrauch. Notes-Präfix bleibt "Import aus Altdaten", damit
      // `createServiceRecordsForImported` (Notes-LIKE-Filter) diese Termine
      // weiterhin in synthetische Leistungsnachweise aufnimmt. KEIN Trim-Retry —
      // es gibt nichts zu kürzen.
      if (isDocOnlyRow(row)) {
        try {
          await importSingleRow(
            row,
            effectiveEmployeeId,
            userId,
            row.durationMinutes,
            "Import aus Altdaten (Dokumentation, ohne Budgetverbrauch)",
            importBatchId,
            true,
          );
          result.documentationOnly++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push({ rowIndex: row.rowIndex, error: msg });
        }
        continue;
      }

      try {
        await importSingleRow(row, effectiveEmployeeId, userId, row.durationMinutes, "Import aus Altdaten", importBatchId);
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
            await importSingleRow(row, effectiveEmployeeId, userId, trimmedMinutes, trimNote, importBatchId);
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
      const appointmentId = row.existingAppointmentId;

      // Task #647: Update braucht alle Stamm-IDs, damit Service-Art /
      // Dauer / End-Zeit / Mitarbeiter aus der Excel übernommen werden.
      if (!row.customerId || !effectiveEmployeeId || !row.serviceId) {
        result.errors.push({ rowIndex: row.rowIndex, error: "Fehlende IDs für Update" });
        continue;
      }

      try {
        // Task #647 / #674: Vorher-Werte für Audit-Log laden (außerhalb der
        // Tx — reine Reads, keine Rennbedingung mit dem darauf folgenden
        // Update). Über `appointmentsRepo` (statt direktem Tabellen-Read)
        // erzwingen wir den `deletedAt IS NULL`-Filter — soft-gelöschte
        // Termine dürfen nicht still über den Excel-Import wiederbelebt
        // werden (Soft-Delete-Coverage-Architektur, Task #454).
        const [beforeAppt] = await appointmentsRepo
          .selectColumnsFrom({
            status: appointments.status,
            assignedEmployeeId: appointments.assignedEmployeeId,
            scheduledEnd: appointments.scheduledEnd,
            durationPromised: appointments.durationPromised,
            travelKilometers: appointments.travelKilometers,
          })
          .where(and(eq(appointments.id, appointmentId), appointmentsRepo.activeOnly()))
          .limit(1);

        // Task #674: Wenn der Termin in der Zwischenzeit soft-gelöscht
        // wurde, sauber überspringen statt zu crashen.
        if (!beforeAppt) {
          result.errors.push({
            rowIndex: row.rowIndex,
            error: `Termin #${appointmentId} ist nicht mehr aktiv (gelöscht) — Update übersprungen.`,
          });
          continue;
        }

        const beforeSvcs = await db
          .select({
            serviceId: appointmentServices.serviceId,
            serviceCode: services.code,
            actual: appointmentServices.actualDurationMinutes,
            planned: appointmentServices.plannedDurationMinutes,
          })
          .from(appointmentServices)
          .innerJoin(services, eq(appointmentServices.serviceId, services.id))
          .where(eq(appointmentServices.appointmentId, appointmentId));

        const previousServiceCode = beforeSvcs.length === 1
          ? (beforeSvcs[0].serviceCode ?? null)
          : (beforeSvcs.length > 1 ? "mixed" : null);
        const previousDurationMinutes = beforeSvcs.reduce(
          (s, r2) => s + (r2.actual ?? r2.planned ?? 0),
          0,
        );

        const [newSvc] = await db
          .select({ code: services.code })
          .from(services)
          .where(eq(services.id, row.serviceId))
          .limit(1);
        const newServiceCode = newSvc?.code ?? null;

        const scheduledEnd = row.endTime || row.startTime;

        // Task #643 + #647: Update der appointments-Zeile UND der
        // appointment_services UND Rebook in einer gemeinsamen Transaktion.
        // `rebookAppointmentConsumption` liest danach den AKTUELLEN
        // Service-Mix + km + Datum aus DB und bucht die Consumption
        // entsprechend neu. Drift-Fall Frau Schröder, 18.03.2026:
        // Excel sagt Hauswirtschaft, DB blieb Alltagsbegleitung.
        const rebookInfo = await db.transaction(async (tx) => {
          await tx
            .update(appointments)
            .set({
              travelKilometers: row.kilometers,
              assignedEmployeeId: effectiveEmployeeId,
              performedByEmployeeId: effectiveEmployeeId,
              scheduledEnd,
              actualEnd: row.endTime || null,
              durationPromised: row.durationMinutes,
              notes: "Import-Update aus Altdaten",
              importBatchId: importBatchId ?? null,
            })
            .where(eq(appointments.id, appointmentId));

          // Vorhandene Service-Zeilen ersetzen — Excel liefert genau eine
          // Service-Art (Hauswirtschaft | Alltagsbegleitung).
          await tx
            .delete(appointmentServices)
            .where(eq(appointmentServices.appointmentId, appointmentId));
          await tx.insert(appointmentServices).values({
            appointmentId,
            serviceId: row.serviceId!,
            plannedDurationMinutes: row.durationMinutes,
            actualDurationMinutes: row.durationMinutes,
            details: `Import: ${row.serviceType}`,
          });

          // Task #1190: `rebookAppointmentConsumption` ist ein No-Op (Storno+
          // Neuanlage), wenn es bereits Consumption-Txs gibt. Bei einem
          // `completed` Termin OHNE jegliche Consumption-Tx (z.B. weil ein
          // früherer Import-Lauf den Termin nur als Datensatz anlegte, aber
          // keine Budget-Buchung erzeugte) würde der Rebook still gar nichts
          // buchen. Daher: existiert noch keine Consumption, legen wir sie
          // erstmalig an (gleiche Erstbuchung wie der Upgrade-Pfad, inkl.
          // §45b-FIFO/Kaskade über `createConsumptionTransaction`).
          const existingConsumption = await tx
            .select({ id: budgetTransactions.id })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.appointmentId, appointmentId),
              eq(budgetTransactions.transactionType, "consumption"),
            ))
            .limit(1);

          let info = await rebookAppointmentConsumption(
            { appointmentId, userId },
            tx,
          );
          let freshlyBooked = false;

          if (
            existingConsumption.length === 0 &&
            !info.rebooked &&
            beforeAppt.status === "completed" &&
            // Task #1243: Vorjahres-Termin echter Pflegekasse → keine
            // (Erst-)Buchung nachziehen, sonst würde der Backfill an genau dem
            // §45b-Null-Budget hart blocken, das wir vermeiden wollen.
            !isDocOnlyRow(row)
          ) {
            const isHauswirtschaft = isHauswirtschaftArt(row.serviceType);
            await budgetLedgerStorage.createConsumptionTransaction(
              {
                customerId: row.customerId!,
                appointmentId,
                transactionDate: row.date,
                hauswirtschaftMinutes: isHauswirtschaft ? row.durationMinutes : 0,
                alltagsbegleitungMinutes: isHauswirtschaft ? 0 : row.durationMinutes,
                travelKilometers: row.kilometers,
                customerKilometers: 0,
                userId,
              },
              tx,
            );
            freshlyBooked = true;
            info = {
              ...info,
              hauswirtschaftMinutes: isHauswirtschaft ? row.durationMinutes : 0,
              alltagsbegleitungMinutes: isHauswirtschaft ? 0 : row.durationMinutes,
              transactionDate: row.date,
            };
          }

          // Task #819: neu gebuchte Budget-Consumption mit dem Batch verknüpfen.
          if (importBatchId != null) {
            await tx
              .update(budgetTransactions)
              .set({ importBatchId })
              .where(eq(budgetTransactions.appointmentId, appointmentId));
          }

          return { ...info, freshlyBooked };
        });

        if ((rebookInfo.rebooked || rebookInfo.freshlyBooked) && row.customerId != null) {
          await auditService.log(
            userId,
            "appointment_km_rebooked",
            "appointment",
            appointmentId,
            {
              customerId: row.customerId,
              trigger: REBOOK_TRIGGERS.import.update,
              // Task #1190: Erstbuchung statt Storno+Neuanlage (Termin hatte
              // keine Consumption-Tx). Im Audit-Trail unterscheidbar.
              firstTimeBooking: rebookInfo.freshlyBooked,
              previousTransactionDate: rebookInfo.previousTransactionDate,
              transactionDate: rebookInfo.transactionDate,
              previousTravelKm: rebookInfo.previousTravelKm,
              newTravelKm: row.kilometers,
              previousCustomerKm: rebookInfo.previousCustomerKm,
              previousHauswirtschaftMinutes: rebookInfo.previousHauswirtschaftMinutes,
              previousAlltagsbegleitungMinutes: rebookInfo.previousAlltagsbegleitungMinutes,
              hauswirtschaftMinutes: rebookInfo.hauswirtschaftMinutes,
              alltagsbegleitungMinutes: rebookInfo.alltagsbegleitungMinutes,
              reversedTransactionIds: rebookInfo.reversedTransactionIds,
              // Task #647: vollständiger Vorher/Nachher-Trail über alle
              // jetzt vom Update-Pfad geschriebenen Felder.
              previousServiceCode,
              newServiceCode,
              previousDurationMinutes,
              newDurationMinutes: row.durationMinutes,
              previousAssignedEmployeeId: beforeAppt?.assignedEmployeeId ?? null,
              newAssignedEmployeeId: effectiveEmployeeId,
              previousScheduledEnd: beforeAppt?.scheduledEnd ?? null,
              newScheduledEnd: scheduledEnd,
            },
          );
        }

        result.updated++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ rowIndex: row.rowIndex, error: msg });
      }
    }

    // Task #708: Upgrade-Pfad — bisher nur geplanter Termin wird auf
    // `completed` angehoben, actualStart/actualEnd/signedAt nachgetragen,
    // Service-Zuordnung anhand Excel ersetzt und die Budget-Consumption
    // erstmalig gebucht (KEIN Rebook — vorher gab es keine Consumption).
    if (action.action === "upgrade" && row.existingAppointmentId) {
      const appointmentId = row.existingAppointmentId;

      if (!row.customerId || !effectiveEmployeeId || !row.serviceId) {
        result.errors.push({ rowIndex: row.rowIndex, error: "Fehlende IDs für Upgrade" });
        continue;
      }

      try {
        const [beforeAppt] = await appointmentsRepo
          .selectColumnsFrom({
            status: appointments.status,
            signedAt: appointments.signedAt,
            assignedEmployeeId: appointments.assignedEmployeeId,
            scheduledEnd: appointments.scheduledEnd,
            durationPromised: appointments.durationPromised,
            travelKilometers: appointments.travelKilometers,
          })
          .where(and(eq(appointments.id, appointmentId), appointmentsRepo.activeOnly()))
          .limit(1);

        if (!beforeAppt) {
          result.errors.push({
            rowIndex: row.rowIndex,
            error: `Termin #${appointmentId} ist nicht mehr aktiv — Upgrade übersprungen.`,
          });
          continue;
        }

        // Defense-in-Depth: wenn der Termin in der Zwischenzeit doch
        // unterschrieben oder anderweitig abgeschlossen wurde, nicht
        // mehr upgraden (Idempotenz / Race-Schutz).
        if (beforeAppt.status !== "scheduled" || beforeAppt.signedAt != null) {
          result.skipped++;
          continue;
        }

        const scheduledEnd = row.endTime || row.startTime;
        const isHauswirtschaft = isHauswirtschaftArt(row.serviceType);
        const hwMinutes = isHauswirtschaft ? row.durationMinutes : 0;
        const abMinutes = isHauswirtschaft ? 0 : row.durationMinutes;
        const signedAt = new Date();
        // Task #1243: Vorjahres-Upgrade echter Pflegekasse → Termin auf
        // `completed` heben, aber keine Consumption buchen (Budget = 0).
        const upgradeDocOnly = isDocOnlyRow(row);

        await db.transaction(async (tx) => {
          await tx
            .update(appointments)
            .set({
              status: "completed",
              actualStart: row.startTime,
              actualEnd: row.endTime || null,
              scheduledEnd,
              durationPromised: row.durationMinutes,
              assignedEmployeeId: effectiveEmployeeId,
              performedByEmployeeId: effectiveEmployeeId,
              travelKilometers: row.kilometers,
              signedAt,
              signedByUserId: userId,
              notes: "Import-Upgrade aus Altdaten",
            })
            .where(eq(appointments.id, appointmentId));

          await tx
            .delete(appointmentServices)
            .where(eq(appointmentServices.appointmentId, appointmentId));
          await tx.insert(appointmentServices).values({
            appointmentId,
            serviceId: row.serviceId!,
            plannedDurationMinutes: row.durationMinutes,
            actualDurationMinutes: row.durationMinutes,
            details: `Import-Upgrade: ${row.serviceType}`,
          });

          if (!upgradeDocOnly) {
            await budgetLedgerStorage.createConsumptionTransaction(
              {
                customerId: row.customerId!,
                appointmentId,
                transactionDate: row.date,
                hauswirtschaftMinutes: hwMinutes,
                alltagsbegleitungMinutes: abMinutes,
                travelKilometers: row.kilometers,
                customerKilometers: 0,
                userId,
              },
              tx,
            );
          }

          // Task #819: Upgrade-Consumption mit dem Import-Batch verknüpfen.
          if (importBatchId != null) {
            await tx
              .update(budgetTransactions)
              .set({ importBatchId })
              .where(eq(budgetTransactions.appointmentId, appointmentId));
          }
        });

        await auditService.log(
          userId,
          "appointment_km_rebooked",
          "appointment",
          appointmentId,
          {
            customerId: row.customerId,
            trigger: REBOOK_TRIGGERS.import.upgrade,
            previousStatus: beforeAppt.status,
            newStatus: "completed",
            actualStart: row.startTime,
            actualEnd: row.endTime ?? null,
            signedAt: signedAt.toISOString(),
            hauswirtschaftMinutes: hwMinutes,
            alltagsbegleitungMinutes: abMinutes,
            travelKilometers: row.kilometers,
            previousTravelKm: beforeAppt.travelKilometers ?? 0,
            previousAssignedEmployeeId: beforeAppt.assignedEmployeeId ?? null,
            newAssignedEmployeeId: effectiveEmployeeId,
            previousDurationMinutes: beforeAppt.durationPromised ?? 0,
            newDurationMinutes: row.durationMinutes,
            // Task #1243: macht im Audit-Trail sichtbar, dass dieser Upgrade
            // bewusst KEINE Budget-Buchung erzeugt hat (Vorjahres-Dokumentation).
            documentationOnly: upgradeDocOnly,
          },
        );

        result.upgraded++;
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
