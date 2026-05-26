/**
 * Task #626 — Bestandsaudit der Termin-vs-Budget-Drift (km / Minuten / Datum).
 *
 * Hintergrund:
 *   Task #618 hat den Termin-Edit-Pfad so erweitert, dass Änderungen an km,
 *   Service-Minuten, Datum oder Services automatisch via
 *   `rebookAppointmentConsumption` in die `budget_transactions` durchgeschrieben
 *   werden. Termine, die VOR diesem Fix editiert wurden, behalten potenziell
 *   ihre alten Buchungswerte (Drift). Der Boot-Audit
 *   `server/startup/audit-appointment-budget-km-drift.ts` (Task #616) deckt
 *   nur den km-Anteil ab — Datum/Minuten-Drift bleibt dort unsichtbar.
 *
 *   Dieses Skript ist die einmalige (oder bei Bedarf wiederholbare) Inventur
 *   über alle dokumentierten Termine. Es vergleicht für jeden Termin mit
 *   bestehenden `consumption`-Buchungen:
 *     - travelKilometers       (Termin vs. Σ tx)
 *     - customerKilometers     (Termin vs. Σ tx)
 *     - hauswirtschaftMinutes  (Σ aus appointment_services nach lohnart_kategorie
 *                               vs. Σ tx)
 *     - alltagsbegleitungMinutes (analog)
 *     - transactionDate        (Termin-Datum vs. Buchungsdatum der ersten Tx)
 *
 * Vorgehen:
 *   - Trockenlauf (default): nur Bericht (stdout-Tabelle + optional CSV via
 *     --csv=path).
 *   - --apply: ruft pro Drift-Termin `rebookAppointmentConsumption` auf — der
 *     GENAU GLEICHE Pfad, den der Termin-Edit-Hook seit #618 nutzt. Damit
 *     erbt das Skript auch das Storno+Neu-Anlage-GoBD-Verhalten + das
 *     `appointment_km_rebooked`-Audit (Task #626 als Quelle).
 *
 * GoBD-Hinweise:
 *   - Geschlossene Monate werden standardmäßig übersprungen. Mit
 *     `--allow-closed-months` ausdrücklich einbeziehen.
 *   - `--apply` erfordert `--user=<superadmin-id>` + `--reason="…"` (≥10
 *     Zeichen), damit jede Korrektur einem Superadmin zuordenbar ist.
 *
 * Aufruf:
 *   Trockenlauf:        tsx server/scripts/audit-appointment-budget-drift.ts
 *   CSV-Export:         tsx server/scripts/audit-appointment-budget-drift.ts --csv=drift.csv
 *   Bestimmter Kunde:   tsx server/scripts/audit-appointment-budget-drift.ts --customer=12
 *   Bestimmte Termine:  tsx server/scripts/audit-appointment-budget-drift.ts --appointment=39,57
 *   Scharf ausführen:   tsx server/scripts/audit-appointment-budget-drift.ts --apply \
 *                          --user=<superadmin-id> --reason="Bestandsdrift Task #626"
 *   Inkl. geschlossener Monate: … --allow-closed-months
 */

import { writeFileSync } from "node:fs";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  appointmentServices,
  budgetTransactions,
  services,
  users,
} from "@shared/schema";
import { rebookAppointmentConsumption } from "../storage/budget/km-rebook";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { auditService } from "../services/audit";

const KM_TOLERANCE = 0.05;

interface CliArgs {
  apply: boolean;
  appointmentIds: number[];
  customerIds: number[];
  userId?: number;
  reason?: string;
  allowClosedMonths: boolean;
  csvPath?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowClosedMonths = args.includes("--allow-closed-months");
  const apptArg = args.find(a => a.startsWith("--appointment="));
  const customerArg = args.find(a => a.startsWith("--customer="));
  const userArg = args.find(a => a.startsWith("--user="));
  const reasonArg = args.find(a => a.startsWith("--reason="));
  const csvArg = args.find(a => a.startsWith("--csv="));

  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s.split("=")[1].split(",")
      .map(x => parseInt(x.trim(), 10))
      .filter(n => !isNaN(n));
  };

  const userId = userArg ? parseInt(userArg.split("=")[1], 10) : undefined;
  const reason = reasonArg ? reasonArg.split("=").slice(1).join("=").trim() : undefined;
  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  return {
    apply,
    appointmentIds: parseIds(apptArg),
    customerIds: parseIds(customerArg),
    userId: userId !== undefined && !isNaN(userId) ? userId : undefined,
    reason: reason && reason.length > 0 ? reason : undefined,
    allowClosedMonths,
    csvPath: csvPath && csvPath.length > 0 ? csvPath : undefined,
  };
}

export interface DriftRow {
  appointmentId: number;
  customerId: number;
  date: string;
  assignedEmployeeId: number | null;
  apptTravelKm: number;
  apptCustomerKm: number;
  txTravelKmSum: number;
  txCustomerKmSum: number;
  apptHwMinutes: number;
  apptAbMinutes: number;
  txHwMinutes: number;
  txAbMinutes: number;
  txDate: string | null;
  driftKm: boolean;
  driftMinutes: boolean;
  driftDate: boolean;
}

export async function findDriftRows(opts: {
  appointmentIds?: number[];
  customerIds?: number[];
}): Promise<DriftRow[]> {
  const whereParts = [isNull(appointments.deletedAt)];
  if (opts.appointmentIds && opts.appointmentIds.length > 0) {
    whereParts.push(inArray(appointments.id, opts.appointmentIds));
  }
  if (opts.customerIds && opts.customerIds.length > 0) {
    whereParts.push(inArray(appointments.customerId, opts.customerIds));
  }

  const apptRows = await db.select({
    id: appointments.id,
    customerId: appointments.customerId,
    date: appointments.date,
    travelKm: appointments.travelKilometers,
    customerKm: appointments.customerKilometers,
    assignedEmployeeId: appointments.assignedEmployeeId,
  })
    .from(appointments)
    .where(and(...whereParts));

  if (apptRows.length === 0) return [];

  const apptIds = apptRows.map(a => a.id);

  // Service-Minuten pro Termin nach lohnart_kategorie summieren.
  const svcRows = await db.select({
    appointmentId: appointmentServices.appointmentId,
    actual: appointmentServices.actualDurationMinutes,
    planned: appointmentServices.plannedDurationMinutes,
    kategorie: services.lohnartKategorie,
  })
    .from(appointmentServices)
    .innerJoin(services, eq(appointmentServices.serviceId, services.id))
    .where(inArray(appointmentServices.appointmentId, apptIds));

  const svcByAppt = new Map<number, { hw: number; ab: number }>();
  for (const r of svcRows) {
    const acc = svcByAppt.get(r.appointmentId) ?? { hw: 0, ab: 0 };
    const m = r.actual ?? r.planned ?? 0;
    if (r.kategorie === "hauswirtschaft") acc.hw += m;
    else if (r.kategorie === "alltagsbegleitung") acc.ab += m;
    svcByAppt.set(r.appointmentId, acc);
  }

  // Consumption-Tx-Summen pro Termin (km + Minuten + erstes Buchungsdatum).
  const txRows = await db.select({
    appointmentId: budgetTransactions.appointmentId,
    travelKm: budgetTransactions.travelKilometers,
    customerKm: budgetTransactions.customerKilometers,
    hw: budgetTransactions.hauswirtschaftMinutes,
    ab: budgetTransactions.alltagsbegleitungMinutes,
    date: budgetTransactions.transactionDate,
  })
    .from(budgetTransactions)
    .where(and(
      inArray(budgetTransactions.appointmentId, apptIds),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  const txByAppt = new Map<number, {
    travel: number; customer: number; hw: number; ab: number; date: string | null;
  }>();
  for (const t of txRows) {
    if (t.appointmentId == null) continue;
    const acc = txByAppt.get(t.appointmentId) ?? { travel: 0, customer: 0, hw: 0, ab: 0, date: null };
    acc.travel += t.travelKm ?? 0;
    acc.customer += t.customerKm ?? 0;
    acc.hw += t.hw ?? 0;
    acc.ab += t.ab ?? 0;
    if (acc.date === null) acc.date = typeof t.date === "string" ? t.date : String(t.date);
    txByAppt.set(t.appointmentId, acc);
  }

  const out: DriftRow[] = [];
  for (const a of apptRows) {
    const tx = txByAppt.get(a.id);
    if (!tx) continue; // Keine Consumption — kein Drift möglich.
    const svc = svcByAppt.get(a.id) ?? { hw: 0, ab: 0 };
    const apptTravel = a.travelKm ?? 0;
    const apptCustomer = a.customerKm ?? 0;
    const apptDate = typeof a.date === "string" ? a.date : String(a.date);

    const driftKm =
      Math.abs(apptTravel - tx.travel) > KM_TOLERANCE ||
      Math.abs(apptCustomer - tx.customer) > KM_TOLERANCE;
    const driftMinutes = svc.hw !== tx.hw || svc.ab !== tx.ab;
    const driftDate = tx.date !== null && tx.date !== apptDate;

    if (!driftKm && !driftMinutes && !driftDate) continue;

    out.push({
      appointmentId: a.id,
      customerId: a.customerId!,
      date: apptDate,
      assignedEmployeeId: a.assignedEmployeeId ?? null,
      apptTravelKm: apptTravel,
      apptCustomerKm: apptCustomer,
      txTravelKmSum: tx.travel,
      txCustomerKmSum: tx.customer,
      apptHwMinutes: svc.hw,
      apptAbMinutes: svc.ab,
      txHwMinutes: tx.hw,
      txAbMinutes: tx.ab,
      txDate: tx.date,
      driftKm,
      driftMinutes,
      driftDate,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.appointmentId - b.appointmentId));
}

export interface ApplyResult {
  appointmentId: number;
  status: "rebooked" | "noop" | "skipped" | "error";
  detail: string;
  reversedTxIds: number[];
  monthClosed?: boolean;
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db.select({
    id: users.id,
    isSuperAdmin: users.isSuperAdmin,
    isActive: users.isActive,
    displayName: users.displayName,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Termin-Budget-Korrekturen sind auf Superadmins beschränkt.`,
    );
  }
}

async function applyOne(
  c: DriftRow,
  userId: number,
  reason: string,
  allowClosedMonths: boolean,
): Promise<ApplyResult> {
  let monthClosed = false;
  if (c.assignedEmployeeId !== null) {
    monthClosed = await isMonthClosed(c.assignedEmployeeId, c.date);
  }
  if (monthClosed && !allowClosedMonths) {
    return {
      appointmentId: c.appointmentId,
      status: "skipped",
      detail:
        `Monat von Mitarbeiter #${c.assignedEmployeeId} für ${c.date} ist geschlossen — ` +
        `mit --allow-closed-months ausdrücklich erlauben.`,
      reversedTxIds: [],
      monthClosed: true,
    };
  }

  const result = await db.transaction(async (tx) => {
    return rebookAppointmentConsumption(
      { appointmentId: c.appointmentId, userId },
      tx,
    );
  });

  if (!result.rebooked) {
    return {
      appointmentId: c.appointmentId,
      status: "noop",
      detail: "kein Rebook nötig (Drift zwischenzeitlich aufgelöst)",
      reversedTxIds: [],
      monthClosed,
    };
  }

  await auditService.log(userId, "appointment_km_rebooked", "appointment", c.appointmentId, {
    source: "audit-appointment-budget-drift",
    reason,
    monthClosedAtCorrection: monthClosed,
    previousTravelKm: result.previousTravelKm,
    previousCustomerKm: result.previousCustomerKm,
    newTravelKm: c.apptTravelKm,
    newCustomerKm: c.apptCustomerKm,
    previousHauswirtschaftMinutes: result.previousHauswirtschaftMinutes,
    previousAlltagsbegleitungMinutes: result.previousAlltagsbegleitungMinutes,
    newHauswirtschaftMinutes: result.hauswirtschaftMinutes,
    newAlltagsbegleitungMinutes: result.alltagsbegleitungMinutes,
    previousTransactionDate: result.previousTransactionDate,
    newTransactionDate: result.transactionDate,
    reversedTransactionIds: result.reversedTransactionIds,
  });

  const driftLabels = [
    c.driftKm ? "km" : null,
    c.driftMinutes ? "min" : null,
    c.driftDate ? "datum" : null,
  ].filter(Boolean).join("+");

  return {
    appointmentId: c.appointmentId,
    status: "rebooked",
    detail:
      `Rebooked (${driftLabels}): travel ${result.previousTravelKm.toFixed(2)}→${c.apptTravelKm.toFixed(2)} km, ` +
      `customer ${result.previousCustomerKm.toFixed(2)}→${c.apptCustomerKm.toFixed(2)} km, ` +
      `hw ${result.previousHauswirtschaftMinutes}→${result.hauswirtschaftMinutes} min, ` +
      `ab ${result.previousAlltagsbegleitungMinutes}→${result.alltagsbegleitungMinutes} min, ` +
      `date ${result.previousTransactionDate}→${result.transactionDate}` +
      (monthClosed ? ` [im geschlossenen Monat korrigiert]` : ""),
    reversedTxIds: result.reversedTransactionIds,
    monthClosed,
  };
}

function toCsv(rows: DriftRow[]): string {
  const header = [
    "appointmentId", "customerId", "date", "assignedEmployeeId",
    "apptTravelKm", "txTravelKmSum",
    "apptCustomerKm", "txCustomerKmSum",
    "apptHwMinutes", "txHwMinutes",
    "apptAbMinutes", "txAbMinutes",
    "txDate", "driftKm", "driftMinutes", "driftDate",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.appointmentId, r.customerId, r.date, r.assignedEmployeeId ?? "",
      r.apptTravelKm, r.txTravelKmSum,
      r.apptCustomerKm, r.txCustomerKmSum,
      r.apptHwMinutes, r.txHwMinutes,
      r.apptAbMinutes, r.txAbMinutes,
      r.txDate ?? "", r.driftKm, r.driftMinutes, r.driftDate,
    ].join(","));
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error("Fehler: --apply erfordert --reason=\"...\" (≥10 Zeichen Begründung für den Audit-Log).");
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`Modus:               ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`km-Toleranz:         ${KM_TOLERANCE} km`);
  console.log(`Geschlossene Monate: ${args.allowClosedMonths ? "EINBEZIEHEN (--allow-closed-months)" : "überspringen"}`);
  if (args.userId !== undefined) console.log(`Superadmin (User-ID): ${args.userId}`);
  if (args.reason) console.log(`Begründung:          ${args.reason}`);
  if (args.appointmentIds.length > 0) console.log(`Termine:             ${args.appointmentIds.join(", ")}`);
  if (args.customerIds.length > 0) console.log(`Kunden:              ${args.customerIds.join(", ")}`);

  const rows = await findDriftRows({
    appointmentIds: args.appointmentIds.length > 0 ? args.appointmentIds : undefined,
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
  });

  console.log(`\nDrift-Termine gefunden: ${rows.length}`);
  for (const r of rows) {
    const flags = [r.driftKm ? "km" : null, r.driftMinutes ? "min" : null, r.driftDate ? "datum" : null].filter(Boolean).join("+");
    console.log(
      `  appt#${r.appointmentId} (${r.date}, Kunde #${r.customerId}, MA #${r.assignedEmployeeId ?? "—"}) [${flags}]: ` +
        `travel ${r.txTravelKmSum.toFixed(2)} vs ${r.apptTravelKm.toFixed(2)} km, ` +
        `customer ${r.txCustomerKmSum.toFixed(2)} vs ${r.apptCustomerKm.toFixed(2)} km, ` +
        `hw ${r.txHwMinutes} vs ${r.apptHwMinutes} min, ` +
        `ab ${r.txAbMinutes} vs ${r.apptAbMinutes} min, ` +
        `tx-date ${r.txDate} vs ${r.date}`,
    );
  }

  if (args.csvPath) {
    writeFileSync(args.csvPath, toCsv(rows), "utf8");
    console.log(`\nCSV geschrieben: ${args.csvPath}`);
  }

  if (!args.apply) {
    console.log("\nHinweis: Trockenlauf — keine Änderungen geschrieben. Mit --apply --user=<id> --reason=\"…\" ausführen.");
    process.exit(0);
  }

  let rebooked = 0, noop = 0, skipped = 0, errored = 0, closedSkipped = 0;
  for (const r of rows) {
    try {
      const res = await applyOne(r, args.userId!, args.reason!, args.allowClosedMonths);
      console.log(`  appt#${res.appointmentId}: ${res.status} — ${res.detail}`);
      if (res.status === "rebooked") rebooked++;
      else if (res.status === "noop") noop++;
      else if (res.status === "skipped") {
        skipped++;
        if (res.monthClosed) closedSkipped++;
      }
    } catch (err) {
      errored++;
      console.error(`  appt#${r.appointmentId}: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Rebooked:                   ${rebooked}`);
  console.log(`No-Op:                      ${noop}`);
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
