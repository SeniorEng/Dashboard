/**
 * Task #648 — Bestands-Reconcile aus Original-Excels.
 *
 * Hintergrund:
 *   Der Excel-Import-Update-Pfad (`executeImport` → `action === "update"`)
 *   übernahm bisher nur `kilometers` und Notiz auf bereits existierende
 *   Termine. Service-Art (`appointment_services` + zugehörige `services`),
 *   Dauer, End-Zeit und Mitarbeiter aus der Excel wurden ignoriert. Folge:
 *   Termine in der DB können von der Original-Excel abweichen, ohne dass
 *   `audit-appointment-budget-drift.ts` das erkennt — Termin und Budget-
 *   Buchung sind dann gleich falsch und damit konsistent.
 *
 *   Dieses Skript schließt diese Lücke, indem es die Original-Excel gegen
 *   den aktuellen DB-Stand legt und pro Termin Felder vergleicht. Bei
 *   `--apply` werden die abweichenden Felder im Termin **und** in
 *   `appointment_services` korrigiert und das Budget über
 *   `rebookAppointmentConsumption` (Storno+Neuanlage) neu gebucht.
 *
 *   Zusätzlich werden "Geister"-Termine erkannt — d.h. Termine eines
 *   Kunden, deren Notiz mit "Import" beginnt, die aber in der gerade
 *   verarbeiteten Excel nicht mehr vorkommen. Diese werden nur gelistet,
 *   nicht angefasst (Entscheidung über Löschen/Stornieren bleibt manuell).
 *
 * Aufruf:
 *   Trockenlauf:        tsx server/scripts/reconcile-import-from-excel.ts --file=tmp/schroeder.xlsx
 *   CSV-Export:         … --csv=tmp/drift.csv
 *   Bestimmter Kunde:   … --customer=39
 *   Inkl. geschl. Mon.: … --apply … --allow-closed-months
 *
 *   Scharf auf DEV (Probelauf):
 *     DEV_WRITE_CONFIRM_TARGET="<host>/<datenbank>" \
 *       … --apply --target=dev --user=<superadmin-id> --reason="…"
 *
 *   Scharf auf PROD:
 *     … --apply --target=prod --confirm-target="<host>/<datenbank>" \
 *       --user=<superadmin-id> --reason="…"
 *
 * GoBD-Hinweise:
 *   - `--apply` erfordert `--target=prod|dev` — die Klasse wird NICHT
 *     abgeleitet, Vergessen ist ein Abbruch und keine Herabstufung.
 *   - BEIDE Klassen verlangen `--user=<superadmin-id>` und `--reason="…"`
 *     (≥10 Zeichen); der Datenbankname wird an der OFFENEN Verbindung geprüft,
 *     nicht aus der URL gelesen.
 *   - Geschlossene Monate werden standardmäßig übersprungen.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { eq, and, like, isNull, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { parseProdWriteArgs } from "./lib/prod-write-gate";
import { assertDualTargetOrThrow } from "./lib/dual-target-gate";
import {
  appointments,
  appointmentServices,
  services,
  } from "@shared/schema";
import { parseExcelFile, matchRows, type MatchedRow } from "../services/appointment-import";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { auditService } from "../services/audit";

const KM_TOLERANCE = 0.01;

/**
 * Die gemeinsamen Flags kommen aus der SSoT, nicht aus einer Zweitliste.
 * Abgeleitet kann sie nicht auseinanderlaufen — vorher fehlte hier bereits
 * `--confirm-target`, das das Ziel-Gate braucht.
 */
type CliArgs = ReturnType<typeof parseProdWriteArgs> & {
  file?: string;
  csvPath?: string;
  customerIds: number[];
  allowClosedMonths: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s.split(",").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
  };
  const get = (prefix: string): string | undefined => {
    const a = args.find(x => x.startsWith(prefix));
    if (!a) return undefined;
    const v = a.slice(prefix.length).trim();
    return v.length > 0 ? v : undefined;
  };
  // Die gemeinsamen Flags (--apply/--user/--reason/--confirm-target/--target)
  // kommen aus der SSoT, nicht aus dem lokalen `get`. SPREAD statt
  // Feld-fuer-Feld: eine Aufzaehlung kann ein Feld verlieren, und genau so ist
  // `confirmTarget` in reconcile-km-drift verlorengegangen (B1, Gate-2 zu #120).
  const gemeinsam = parseProdWriteArgs(process.argv);
  return {
    ...gemeinsam,
    file: get("--file="),
    csvPath: get("--csv="),
    customerIds: parseIds(get("--customer=")),
    allowClosedMonths: args.includes("--allow-closed-months"),
  };
}

type DriftField =
  | "serviceArt"
  | "durationMinutes"
  | "endTime"
  | "employee"
  | "kilometers";

export interface ExcelDriftRow {
  appointmentId: number;
  customerId: number;
  date: string;
  startTime: string;
  driftFields: DriftField[];
  excel: {
    serviceCategory: string | null;
    serviceId: number | null;
    durationMinutes: number;
    endTime: string;
    employeeId: number | null;
    employeeName: string;
    kilometers: number;
  };
  db: {
    serviceCategory: string | null;
    serviceIds: number[];
    durationMinutes: number;
    endTime: string | null;
    employeeId: number | null;
    kilometers: number;
  };
}

export interface GhostAppointment {
  appointmentId: number;
  customerId: number;
  date: string;
  startTime: string | null;
  travelKilometers: number;
  durationPromised: number | null;
  notes: string | null;
}

export interface ReconcileScanResult {
  drifts: ExcelDriftRow[];
  ghosts: GhostAppointment[];
  unmatched: MatchedRow[];
  errors: MatchedRow[];
}

const SERVICE_TYPE_TO_CATEGORY: Record<string, "hauswirtschaft" | "alltagsbegleitung"> = {
  hauswirtschaft: "hauswirtschaft",
  alltagsbegleitung: "alltagsbegleitung",
};

function excelServiceCategory(serviceType: string): "hauswirtschaft" | "alltagsbegleitung" | null {
  return SERVICE_TYPE_TO_CATEGORY[serviceType.toLowerCase()] ?? null;
}

function timeNorm(s: string | null | undefined): string {
  if (!s) return "";
  return s.length >= 5 ? s.substring(0, 5) : s;
}

export async function scanExcelAgainstDb(
  excelBuffer: Buffer,
  opts: { customerIds?: number[] } = {},
): Promise<ReconcileScanResult> {
  const parsed = await parseExcelFile(excelBuffer);
  const matched = await matchRows(parsed);

  const filtered = opts.customerIds && opts.customerIds.length > 0
    ? matched.filter(r => r.customerId != null && opts.customerIds!.includes(r.customerId))
    : matched;

  const apptIds = filtered
    .filter(r => r.existingAppointmentId != null)
    .map(r => r.existingAppointmentId!) as number[];

  // Aktuelle Termin-Felder + Service-Zuordnungen laden.
  const apptRows = apptIds.length > 0
    ? await db.select({
        id: appointments.id,
        customerId: appointments.customerId,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        scheduledEnd: appointments.scheduledEnd,
        actualEnd: appointments.actualEnd,
        assignedEmployeeId: appointments.assignedEmployeeId,
        performedByEmployeeId: appointments.performedByEmployeeId,
        travelKilometers: appointments.travelKilometers,
      })
        .from(appointments)
        .where(inArray(appointments.id, apptIds))
    : [];
  const apptById = new Map(apptRows.map(a => [a.id, a]));

  const svcRows = apptIds.length > 0
    ? await db.select({
        appointmentId: appointmentServices.appointmentId,
        serviceId: appointmentServices.serviceId,
        actual: appointmentServices.actualDurationMinutes,
        planned: appointmentServices.plannedDurationMinutes,
        kategorie: services.lohnartKategorie,
        code: services.code,
      })
        .from(appointmentServices)
        .innerJoin(services, eq(appointmentServices.serviceId, services.id))
        .where(inArray(appointmentServices.appointmentId, apptIds))
    : [];

  const svcByAppt = new Map<number, {
    duration: number;
    serviceIds: number[];
    categories: Set<string>;
  }>();
  for (const r of svcRows) {
    const acc = svcByAppt.get(r.appointmentId) ?? { duration: 0, serviceIds: [], categories: new Set<string>() };
    acc.duration += r.actual ?? r.planned ?? 0;
    acc.serviceIds.push(r.serviceId);
    if (r.kategorie) acc.categories.add(r.kategorie);
    svcByAppt.set(r.appointmentId, acc);
  }

  const drifts: ExcelDriftRow[] = [];
  const unmatched: MatchedRow[] = [];
  const errors: MatchedRow[] = [];

  for (const row of filtered) {
    if (row.status === "error") {
      errors.push(row);
      continue;
    }
    if (row.existingAppointmentId == null) {
      unmatched.push(row);
      continue;
    }
    const appt = apptById.get(row.existingAppointmentId);
    if (!appt) {
      unmatched.push(row);
      continue;
    }
    const svc = svcByAppt.get(row.existingAppointmentId) ?? { duration: 0, serviceIds: [] as number[], categories: new Set<string>() };

    const excelCat = excelServiceCategory(row.serviceType);
    // DB-„Service-Art": eindeutige Kategorie der Service-Zeilen. Wenn ein
    // Termin mehrere unterschiedliche Kategorien hat (sollte für Import-
    // Bestände nicht vorkommen), zählen wir das als Drift, sobald die
    // Excel eine andere als die erste DB-Kategorie verlangt.
    const dbCats = Array.from(svc.categories);
    const dbCat = dbCats.length === 1 ? dbCats[0] : (dbCats[0] ?? null);

    const dbKm = appt.travelKilometers ?? 0;
    const dbEnd = timeNorm(appt.scheduledEnd ?? appt.actualEnd);
    const excelEnd = timeNorm(row.endTime);
    const dbEmployee = appt.assignedEmployeeId ?? appt.performedByEmployeeId ?? null;

    const driftFields: DriftField[] = [];

    if (excelCat && dbCat && excelCat !== dbCat) driftFields.push("serviceArt");
    // Auch wenn nur ein Service in der Excel steht, der Service-ID-Match
    // aus matchRows aber von der DB-Service-ID abweicht → Service-Drift.
    if (row.serviceId != null && svc.serviceIds.length === 1 && svc.serviceIds[0] !== row.serviceId) {
      if (!driftFields.includes("serviceArt")) driftFields.push("serviceArt");
    }
    if (row.durationMinutes !== svc.duration) driftFields.push("durationMinutes");
    if (excelEnd && dbEnd && excelEnd !== dbEnd) driftFields.push("endTime");
    if (row.employeeId != null && dbEmployee !== row.employeeId) driftFields.push("employee");
    if (Math.abs(dbKm - row.kilometers) > KM_TOLERANCE) driftFields.push("kilometers");

    if (driftFields.length === 0) continue;

    drifts.push({
      appointmentId: appt.id,
      customerId: appt.customerId!,
      date: typeof appt.date === "string" ? appt.date : String(appt.date),
      startTime: timeNorm(appt.scheduledStart),
      driftFields,
      excel: {
        serviceCategory: excelCat,
        serviceId: row.serviceId,
        durationMinutes: row.durationMinutes,
        endTime: excelEnd,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        kilometers: row.kilometers,
      },
      db: {
        serviceCategory: dbCat,
        serviceIds: svc.serviceIds,
        durationMinutes: svc.duration,
        endTime: dbEnd,
        employeeId: dbEmployee,
        kilometers: dbKm,
      },
    });
  }

  // Geister: Termine eines Kunden mit Notiz LIKE 'Import%' (vom Import-Pfad
  // gesetzte Notiz), deren (customerId, date, startTime)-Schlüssel in der
  // Excel nicht vorkommt.
  const customerIdsInExcel = Array.from(new Set(
    filtered.filter(r => r.customerId != null).map(r => r.customerId!),
  ));

  const excelKeys = new Set<string>();
  for (const r of filtered) {
    if (r.customerId == null || !r.date || !r.startTime) continue;
    excelKeys.add(`${r.customerId}|${r.date}|${r.startTime}`);
  }

  const ghosts: GhostAppointment[] = [];
  if (customerIdsInExcel.length > 0) {
    const importApps = await db.select({
      id: appointments.id,
      customerId: appointments.customerId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      travelKilometers: appointments.travelKilometers,
      durationPromised: appointments.durationPromised,
      notes: appointments.notes,
    })
      .from(appointments)
      .where(and(
        isNull(appointments.deletedAt),
        inArray(appointments.customerId, customerIdsInExcel),
        like(appointments.notes, "Import%"),
      ));

    for (const a of importApps) {
      const dateStr = typeof a.date === "string" ? a.date : String(a.date);
      const startStr = timeNorm(a.scheduledStart);
      const key = `${a.customerId}|${dateStr}|${startStr}`;
      if (excelKeys.has(key)) continue;
      ghosts.push({
        appointmentId: a.id,
        customerId: a.customerId!,
        date: dateStr,
        startTime: startStr || null,
        travelKilometers: a.travelKilometers ?? 0,
        durationPromised: a.durationPromised ?? null,
        notes: a.notes,
      });
    }
  }

  drifts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.appointmentId - b.appointmentId));
  ghosts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.appointmentId - b.appointmentId));

  return { drifts, ghosts, unmatched, errors };
}

export interface ApplyOutcome {
  appointmentId: number;
  status: "rebooked" | "noop" | "skipped" | "error";
  detail: string;
  monthClosed?: boolean;
}


export async function applyDrift(
  drift: ExcelDriftRow,
  userId: number,
  reason: string,
  allowClosedMonths: boolean,
): Promise<ApplyOutcome> {
  let monthClosed = false;
  const targetEmployee = drift.excel.employeeId ?? drift.db.employeeId;
  if (targetEmployee != null) {
    monthClosed = await isMonthClosed(targetEmployee, drift.date);
  }
  if (monthClosed && !allowClosedMonths) {
    return {
      appointmentId: drift.appointmentId,
      status: "skipped",
      detail: `Monat von Mitarbeiter #${targetEmployee} für ${drift.date} ist geschlossen — mit --allow-closed-months ausdrücklich erlauben.`,
      monthClosed: true,
    };
  }

  const before = {
    serviceCategory: drift.db.serviceCategory,
    serviceIds: [...drift.db.serviceIds],
    durationMinutes: drift.db.durationMinutes,
    endTime: drift.db.endTime,
    employeeId: drift.db.employeeId,
    kilometers: drift.db.kilometers,
  };
  const after = {
    serviceCategory: drift.excel.serviceCategory,
    serviceId: drift.excel.serviceId,
    durationMinutes: drift.excel.durationMinutes,
    endTime: drift.excel.endTime,
    employeeId: drift.excel.employeeId,
    kilometers: drift.excel.kilometers,
  };

  const rebookResult = await db.transaction(async (tx) => {
    const update: Record<string, unknown> = {
      travelKilometers: drift.excel.kilometers,
    };
    if (drift.excel.endTime) {
      update.scheduledEnd = drift.excel.endTime;
    }
    if (drift.excel.employeeId != null) {
      update.assignedEmployeeId = drift.excel.employeeId;
      update.performedByEmployeeId = drift.excel.employeeId;
    }
    await tx.update(appointments).set(update).where(eq(appointments.id, drift.appointmentId));

    if (drift.excel.serviceId != null) {
      // Alle bisherigen Service-Zeilen löschen und mit der Excel-Service-ID +
      // Excel-Dauer neu anlegen. Mehrere Service-Zeilen pro Import-Termin
      // sind nicht vorgesehen.
      await tx.delete(appointmentServices).where(eq(appointmentServices.appointmentId, drift.appointmentId));
      await tx.insert(appointmentServices).values({
        appointmentId: drift.appointmentId,
        serviceId: drift.excel.serviceId,
        plannedDurationMinutes: drift.excel.durationMinutes,
        actualDurationMinutes: drift.excel.durationMinutes,
        details: "Reconcile aus Original-Excel (Task #648)",
      });
    }

    return rebookAppointmentConsumption({ appointmentId: drift.appointmentId, userId }, tx);
  });

  await auditService.log(
    userId,
    "appointment_km_rebooked",
    "appointment",
    drift.appointmentId,
    {
      customerId: drift.customerId,
      trigger: REBOOK_TRIGGERS.reconcile.fromExcel,
      source: "reconcile-import-from-excel",
      reason,
      driftFields: drift.driftFields,
      monthClosedAtCorrection: monthClosed,
      before,
      after,
      rebooked: rebookResult.rebooked,
      previousTransactionDate: rebookResult.previousTransactionDate,
      newTransactionDate: rebookResult.transactionDate,
      previousTravelKm: rebookResult.previousTravelKm,
      newTravelKm: drift.excel.kilometers,
      previousCustomerKm: rebookResult.previousCustomerKm,
      previousHauswirtschaftMinutes: rebookResult.previousHauswirtschaftMinutes,
      previousAlltagsbegleitungMinutes: rebookResult.previousAlltagsbegleitungMinutes,
      hauswirtschaftMinutes: rebookResult.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: rebookResult.alltagsbegleitungMinutes,
      reversedTransactionIds: rebookResult.reversedTransactionIds,
    },
  );

  const summary = drift.driftFields.join("+");
  return {
    appointmentId: drift.appointmentId,
    status: rebookResult.rebooked ? "rebooked" : "noop",
    detail: rebookResult.rebooked
      ? `Korrigiert (${summary})` + (monthClosed ? " [im geschlossenen Monat]" : "")
      : `Felder korrigiert, Budget bereits konsistent (${summary})`,
    monthClosed,
  };
}

function toCsv(drifts: ExcelDriftRow[]): string {
  const header = [
    "appointmentId", "customerId", "date", "startTime",
    "driftFields",
    "excelServiceCategory", "dbServiceCategory",
    "excelDurationMinutes", "dbDurationMinutes",
    "excelEndTime", "dbEndTime",
    "excelEmployeeId", "dbEmployeeId",
    "excelKilometers", "dbKilometers",
  ];
  const lines = [header.join(",")];
  for (const d of drifts) {
    lines.push([
      d.appointmentId, d.customerId, d.date, d.startTime,
      d.driftFields.join("|"),
      d.excel.serviceCategory ?? "", d.db.serviceCategory ?? "",
      d.excel.durationMinutes, d.db.durationMinutes,
      d.excel.endTime, d.db.endTime ?? "",
      d.excel.employeeId ?? "", d.db.employeeId ?? "",
      d.excel.kilometers, d.db.kilometers,
    ].join(","));
  }
  return lines.join("\n");
}

function summarizeByCustomer(drifts: ExcelDriftRow[]): string[] {
  const byCust = new Map<number, { total: number; fields: Map<DriftField, number> }>();
  for (const d of drifts) {
    const acc = byCust.get(d.customerId) ?? { total: 0, fields: new Map<DriftField, number>() };
    acc.total++;
    for (const f of d.driftFields) {
      acc.fields.set(f, (acc.fields.get(f) ?? 0) + 1);
    }
    byCust.set(d.customerId, acc);
  }
  const out: string[] = [];
  for (const [cid, info] of byCust) {
    const parts = Array.from(info.fields.entries()).map(([f, n]) => `${n}× ${f}`).join(", ");
    out.push(`  Kunde #${cid}: ${info.total} Termin(e) mit Drift (${parts})`);
  }
  return out;
}

async function main() {
  const args = parseArgs();

  if (!args.file) {
    console.error("Fehler: --file=<pfad-zur-excel> ist erforderlich.");
    process.exit(1);
  }

  if (args.apply) {
    // KLASSE: Dual-Target, nicht Prod-only.
    //
    // Beide Wege sind legitim: die Reparatur laeuft am Ende gegen Prod, wird
    // aber sinnvollerweise ZUERST auf der Dev-Kopie geprobt (die Dev-DB ist
    // laut CLAUDE.md eine Prod-Kopie). Ein reines Prod-Gate verlangt
    // NODE_ENV=production und haette den Probelauf unmoeglich gemacht —
    // gemessen beim Verhaltenstest, nicht vermutet.
    //
    // Die Klasse wird NICHT abgeleitet: ohne `--target` bricht es ab. Waere
    // sie ableitbar, haenge die Sicherheitsstufe an einem vergessenen Flag.
    //
    // Das Gate prueft auf DERSELBEN Verbindung, ueber die danach geschrieben
    // wird (`current_database()`, nicht die URL), und erteilt die Freigabe fuer
    // die Laufzeit-Schreibsperre (#117).
    //
    // ERSETZT drei Handpruefungen (--user vorhanden, --reason >= 10 Zeichen,
    // lokale Superadmin-Kopie) UND ergaenzt das, was allen dreien fehlte: die
    // Ziel-Pruefung.
    const freigabe = await assertDualTargetOrThrow(
      args,
      "Termin-Reconcile gegen die Original-Excel (Felder + Budget-Neubuchung).",
    );
    console.log(`Ziel-Klasse: ${freigabe.klasse} · bestaetigt: ${freigabe.ziel}`);
  }

  console.log(`Modus:               ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Excel:               ${args.file}`);
  console.log(`Geschlossene Monate: ${args.allowClosedMonths ? "EINBEZIEHEN (--allow-closed-months)" : "überspringen"}`);
  if (args.userId !== undefined) console.log(`Superadmin (User-ID): ${args.userId}`);
  if (args.reason) console.log(`Begründung:          ${args.reason}`);
  if (args.customerIds.length > 0) console.log(`Kunden:              ${args.customerIds.join(", ")}`);

  const buffer = readFileSync(args.file);
  const scan = await scanExcelAgainstDb(buffer, {
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
  });

  console.log(`\nDrift-Termine gefunden: ${scan.drifts.length}`);
  console.log(`Geister-Termine (nur in DB): ${scan.ghosts.length}`);
  console.log(`Unmatched Excel-Zeilen (kein DB-Termin): ${scan.unmatched.length}`);
  console.log(`Excel-Zeilen mit Match-Fehler: ${scan.errors.length}`);

  if (scan.drifts.length > 0) {
    console.log(`\n--- Drift-Details ---`);
    for (const d of scan.drifts) {
      const parts: string[] = [];
      if (d.driftFields.includes("serviceArt")) {
        parts.push(`Service ${d.db.serviceCategory ?? "—"}→${d.excel.serviceCategory ?? "—"}`);
      }
      if (d.driftFields.includes("durationMinutes")) {
        parts.push(`Dauer ${d.db.durationMinutes}→${d.excel.durationMinutes}min`);
      }
      if (d.driftFields.includes("endTime")) {
        parts.push(`Ende ${d.db.endTime ?? "—"}→${d.excel.endTime}`);
      }
      if (d.driftFields.includes("employee")) {
        parts.push(`MA #${d.db.employeeId ?? "—"}→#${d.excel.employeeId ?? "—"} (${d.excel.employeeName})`);
      }
      if (d.driftFields.includes("kilometers")) {
        parts.push(`km ${d.db.kilometers.toFixed(2)}→${d.excel.kilometers.toFixed(2)}`);
      }
      console.log(`  appt#${d.appointmentId} (${d.date} ${d.startTime}, Kunde #${d.customerId}): ${parts.join(", ")}`);
    }
    console.log(`\n--- Pro Kunde ---`);
    for (const line of summarizeByCustomer(scan.drifts)) console.log(line);
  }

  if (scan.ghosts.length > 0) {
    console.log(`\n--- Geister (nur in DB, nicht in Excel — manuell prüfen) ---`);
    for (const g of scan.ghosts) {
      console.log(
        `  appt#${g.appointmentId} (Kunde #${g.customerId}, ${g.date} ${g.startTime ?? "—"}): ` +
          `${g.durationPromised ?? "?"}min / ${g.travelKilometers.toFixed(2)}km — notes="${g.notes ?? ""}"`,
      );
    }
  }

  if (args.csvPath) {
    writeFileSync(args.csvPath, toCsv(scan.drifts), "utf8");
    console.log(`\nCSV geschrieben: ${args.csvPath}`);
  }

  if (!args.apply) {
    console.log(`\nHinweis: Trockenlauf — keine Änderungen geschrieben.`);
    console.log(`Mit --apply --user=<superadmin-id> --reason="…" scharf ausführen.`);
    process.exit(0);
  }

  console.log(`\n--- Apply ---`);
  let rebooked = 0, noop = 0, skipped = 0, errored = 0, closedSkipped = 0;
  for (const d of scan.drifts) {
    try {
      const out = await applyDrift(d, args.userId!, args.reason!, args.allowClosedMonths);
      console.log(`  appt#${out.appointmentId}: ${out.status} — ${out.detail}`);
      if (out.status === "rebooked") rebooked++;
      else if (out.status === "noop") noop++;
      else if (out.status === "skipped") {
        skipped++;
        if (out.monthClosed) closedSkipped++;
      }
    } catch (err) {
      errored++;
      console.error(`  appt#${d.appointmentId}: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Rebooked:                   ${rebooked}`);
  console.log(`No-Op (Felder ok):          ${noop}`);
  console.log(`Übersprungen (gesamt):      ${skipped}`);
  console.log(`  davon geschlossener Monat: ${closedSkipped}`);
  console.log(`Fehler:                     ${errored}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
