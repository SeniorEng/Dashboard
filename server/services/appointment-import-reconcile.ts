/**
 * Task #669 — Import-Reconcile.
 *
 * Optionaler Schritt nach dem Excel-Import-Preview: für einen vom Superadmin
 * gewählten Scope (Kunden + Zeitraum) wird die Excel als Single Source of
 * Truth interpretiert. DB-Termine, die in diesem Scope NICHT in der Excel
 * vorkommen, werden GoBD-konform soft-gelöscht / auf `cancelled` gesetzt;
 * Budget-Verbrauch wird vollständig storniert. Audit-Trail pro Termin +
 * pro Batch (Batch-UUID im Audit-Metadata).
 *
 * Ausgeschlossen werden (NIE automatisch storniert):
 *   - Termine mit unterschriebenem `monthly_service_records` (employee- ODER
 *     customer-signiert, nicht soft-gelöscht).
 *   - Termine mit eigener Unterschrift (`appointments.signed_at != NULL`).
 *   - Termine in einem für den Mitarbeiter bereits geschlossenen Monat.
 *   - Bereits stornierte / gelöschte Termine (sind ohnehin nicht im Scope).
 *
 * Mehr Kontext im Task-Spec (`.local/tasks/task-669.md`).
 */

import { randomUUID } from "crypto";
import { and, eq, gte, isNull, lte, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  customers,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import { auditService } from "./audit";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { storage } from "../storage";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { appointmentsRepo } from "../repos";

export type ReconcileExclusionReason =
  | "signed_service_record"
  | "signed_appointment"
  | "month_closed";

export interface ReconcileAppointmentInfo {
  appointmentId: number;
  customerId: number;
  customerName: string;
  date: string;
  scheduledStart: string | null;
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
  durationPromised: number;
  status: string;
}

export interface ReconcileExcludedInfo extends ReconcileAppointmentInfo {
  exclusionReason: ReconcileExclusionReason;
  exclusionDetail?: string;
}

export interface ExcelKey {
  customerId: number;
  date: string;
  startTime: string;
}

export interface ReconcilePreviewResult {
  cancellable: ReconcileAppointmentInfo[];
  excluded: ReconcileExcludedInfo[];
}

export interface ReconcileExecuteResult {
  batchId: string;
  cancelled: number;
  reversedTransactions: number;
  excluded: number;
  errors: { appointmentId: number; error: string }[];
}

/** HH:MM aus "HH:MM" oder "HH:MM:SS". */
function trimToHHMM(s: string | null | undefined): string {
  if (!s) return "";
  return s.substring(0, 5);
}

function buildExcelKeySet(keys: ExcelKey[]): Set<string> {
  const set = new Set<string>();
  for (const k of keys) {
    set.add(`${k.customerId}|${k.date}|${trimToHHMM(k.startTime)}`);
  }
  return set;
}

/**
 * Sammelt alle DB-Termine im Scope (aktive Kundentermine in Zeitraum +
 * Kundenliste), klassifiziert sie als `cancellable` (Excel hat sie nicht
 * mehr → würde storniert) oder `excluded` (geschützt, nie automatisch
 * storniert).
 */
export async function previewReconcile(
  customerIds: number[],
  startDate: string,
  endDate: string,
  excelKeys: ExcelKey[],
): Promise<ReconcilePreviewResult> {
  if (customerIds.length === 0) return { cancellable: [], excluded: [] };
  if (!startDate || !endDate || startDate > endDate) {
    throw new Error("Ungültiger Zeitraum");
  }

  const excelSet = buildExcelKeySet(excelKeys);

  const rows = await appointmentsRepo
    .selectColumnsFrom(
      {
        appointmentId: appointments.id,
        customerId: appointments.customerId,
        customerVorname: customers.vorname,
        customerNachname: customers.nachname,
        customerName: customers.name,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        assignedEmployeeId: appointments.assignedEmployeeId,
        performedByEmployeeId: appointments.performedByEmployeeId,
        durationPromised: appointments.durationPromised,
        status: appointments.status,
        signedAt: appointments.signedAt,
      },
      db,
    )
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        inArray(appointments.customerId, customerIds),
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        eq(appointments.appointmentType, "Kundentermin"),
        isNull(appointments.deletedAt),
        // Schon stornierte Termine sind kein Reconcile-Kandidat.
        // (status != "cancelled")
      ),
    );

  // Service-Record-Lookup: welche Termine sind via Join an einen
  // signierten (employee ODER customer) und nicht soft-gelöschten
  // monthly_service_records gebunden?
  const apptIds = rows.map((r) => r.appointmentId);
  const signedRecordAppointmentIds = new Set<number>();
  if (apptIds.length > 0) {
    const signed = await db
      .select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .innerJoin(
        monthlyServiceRecords,
        eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
      )
      .where(
        and(
          inArray(serviceRecordAppointments.appointmentId, apptIds),
          isNull(monthlyServiceRecords.deletedAt),
          or(
            isNotNull(monthlyServiceRecords.employeeSignedAt),
            isNotNull(monthlyServiceRecords.customerSignedAt),
          ),
        ),
      );
    for (const s of signed) signedRecordAppointmentIds.add(s.appointmentId);
  }

  // Month-Close-Lookup pro Mitarbeiter+YYYY-MM, gecacht.
  const monthCloseCache = new Map<string, boolean>();
  async function checkMonthClosed(employeeId: number, dateStr: string): Promise<boolean> {
    const ym = dateStr.substring(0, 7);
    const key = `${employeeId}|${ym}`;
    const cached = monthCloseCache.get(key);
    if (cached !== undefined) return cached;
    const closed = await isMonthClosed(employeeId, dateStr);
    monthCloseCache.set(key, closed);
    return closed;
  }

  const cancellable: ReconcileAppointmentInfo[] = [];
  const excluded: ReconcileExcludedInfo[] = [];

  for (const row of rows) {
    const dateStr = typeof row.date === "string" ? row.date : String(row.date);
    const startStr = trimToHHMM(row.scheduledStart);
    const dupKey = `${row.customerId}|${dateStr}|${startStr}`;

    // Excel hat diesen Termin → nichts zu tun, gehört nicht in den
    // Reconcile-Output (weder cancellable noch excluded).
    if (excelSet.has(dupKey)) continue;

    // Bereits stornierte Termine ignorieren wir komplett (kein
    // doppeltes Stornieren, kein Listen-Rauschen).
    if (row.status === "cancelled") continue;

    const customerName = row.customerVorname && row.customerNachname
      ? `${row.customerVorname} ${row.customerNachname}`
      : (row.customerName ?? "Unbekannt");

    const info: ReconcileAppointmentInfo = {
      appointmentId: row.appointmentId,
      customerId: row.customerId!,
      customerName,
      date: dateStr,
      scheduledStart: startStr || null,
      assignedEmployeeId: row.assignedEmployeeId,
      performedByEmployeeId: row.performedByEmployeeId,
      durationPromised: row.durationPromised,
      status: row.status,
    };

    // Exklusion 1: Signierter Leistungsnachweis verbunden.
    if (signedRecordAppointmentIds.has(row.appointmentId)) {
      excluded.push({
        ...info,
        exclusionReason: "signed_service_record",
        exclusionDetail: "Termin ist Teil eines unterschriebenen Leistungsnachweises",
      });
      continue;
    }

    // Exklusion 2: Eigene Termin-Signatur gesetzt.
    if (row.signedAt) {
      excluded.push({
        ...info,
        exclusionReason: "signed_appointment",
        exclusionDetail: "Termin wurde digital unterschrieben",
      });
      continue;
    }

    // Exklusion 3: Geschlossener Monat (für den primär verantwortlichen
    // Mitarbeiter; performedBy bevorzugt, sonst assignedEmployee).
    const empForCloseCheck = row.performedByEmployeeId ?? row.assignedEmployeeId;
    if (empForCloseCheck != null) {
      const closed = await checkMonthClosed(empForCloseCheck, dateStr);
      if (closed) {
        excluded.push({
          ...info,
          exclusionReason: "month_closed",
          exclusionDetail: "Monat ist bereits geschlossen",
        });
        continue;
      }
    }

    cancellable.push(info);
  }

  cancellable.sort((a, b) => a.date.localeCompare(b.date) || (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
  excluded.sort((a, b) => a.date.localeCompare(b.date) || (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));

  return { cancellable, excluded };
}

/**
 * Führt die eigentliche Stornierung durch. Defense-in-Depth: re-prüft
 * pro Termin die Exklusionsregeln, damit eine zwischenzeitlich
 * gesetzte Signatur / ein zwischenzeitlich geschlossener Monat den
 * Termin doch noch schützt.
 */
export async function executeReconcile(params: {
  appointmentIds: number[];
  reason: string;
  userId: number;
  batchId?: string;
  ipAddress?: string;
  scopeCustomerIds?: number[];
  scopeStartDate?: string;
  scopeEndDate?: string;
}): Promise<ReconcileExecuteResult> {
  const { appointmentIds, reason, userId, ipAddress } = params;
  if (reason.trim().length < 10) {
    throw new Error("Begründung muss mindestens 10 Zeichen lang sein");
  }
  if (appointmentIds.length === 0) {
    return {
      batchId: params.batchId ?? randomUUID(),
      cancelled: 0,
      reversedTransactions: 0,
      excluded: 0,
      errors: [],
    };
  }

  const batchId = params.batchId ?? randomUUID();

  // Task #674: Re-Check aller Termine in einer Sammel-Abfrage. Bewusst über
  // `appointmentsRepo.selectColumnsFrom(...)` OHNE `activeOnly()`, damit
  // soft-gelöschte Zeilen weiterhin gefunden werden — der Reconcile-Pfad
  // muss `deletedAt` lesen, um Drift-Fälle zu erkennen. Der Filter wird
  // nicht vergessen, sondern absichtlich weggelassen; die Repo-Vermittlung
  // dient hier der Architektur-Konsistenz (Soft-Delete-Coverage-Test).
  const rows = await appointmentsRepo
    .selectColumnsFrom({
      id: appointments.id,
      customerId: appointments.customerId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      status: appointments.status,
      deletedAt: appointments.deletedAt,
      signedAt: appointments.signedAt,
      assignedEmployeeId: appointments.assignedEmployeeId,
      performedByEmployeeId: appointments.performedByEmployeeId,
    })
    .where(inArray(appointments.id, appointmentIds));

  const rowById = new Map(rows.map((r) => [r.id, r]));

  const signedRecordSet = new Set<number>();
  if (rows.length > 0) {
    const signed = await db
      .select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .innerJoin(
        monthlyServiceRecords,
        eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
      )
      .where(
        and(
          inArray(serviceRecordAppointments.appointmentId, rows.map((r) => r.id)),
          isNull(monthlyServiceRecords.deletedAt),
          or(
            isNotNull(monthlyServiceRecords.employeeSignedAt),
            isNotNull(monthlyServiceRecords.customerSignedAt),
          ),
        ),
      );
    for (const s of signed) signedRecordSet.add(s.appointmentId);
  }

  let cancelled = 0;
  let reversedTransactions = 0;
  let excluded = 0;
  const errors: { appointmentId: number; error: string }[] = [];

  for (const appointmentId of appointmentIds) {
    try {
      const row = rowById.get(appointmentId);
      if (!row) {
        errors.push({ appointmentId, error: "Termin nicht gefunden" });
        continue;
      }
      if (row.deletedAt || row.status === "cancelled") {
        excluded++;
        continue;
      }
      if (signedRecordSet.has(appointmentId) || row.signedAt) {
        excluded++;
        continue;
      }
      const empForCloseCheck = row.performedByEmployeeId ?? row.assignedEmployeeId;
      const dateStr = typeof row.date === "string" ? row.date : String(row.date);
      if (empForCloseCheck != null) {
        const closed = await isMonthClosed(empForCloseCheck, dateStr);
        if (closed) {
          excluded++;
          continue;
        }
      }

      const transactions = await budgetLedgerStorage.getTransactionsByAppointmentId(appointmentId);
      let reversedHere = 0;

      await db.transaction(async (tx) => {
        for (const t of transactions) {
          // Nur consumption-Txs storno-bedürftig; reversal-Txs ignorieren.
          if (t.transactionType !== "consumption") continue;
          await budgetLedgerStorage.reverseBudgetTransaction(t.id, userId, tx);
          reversedHere++;
        }
        await tx
          .update(appointments)
          .set({
            status: "cancelled",
            deletedAt: new Date(),
          })
          .where(eq(appointments.id, appointmentId));
      });

      reversedTransactions += reversedHere;
      cancelled++;

      await auditService.log(
        userId,
        "appointment_import_reconciled_cancelled",
        "appointment",
        appointmentId,
        {
          batchId,
          reason,
          customerId: row.customerId,
          date: dateStr,
          scheduledStart: trimToHHMM(row.scheduledStart),
          assignedEmployeeId: row.assignedEmployeeId,
          performedByEmployeeId: row.performedByEmployeeId,
          previousStatus: row.status,
          reversedTransactions: reversedHere,
          scope: {
            customerIds: params.scopeCustomerIds ?? null,
            startDate: params.scopeStartDate ?? null,
            endDate: params.scopeEndDate ?? null,
          },
        },
        ipAddress,
      );
    } catch (err) {
      errors.push({
        appointmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { batchId, cancelled, reversedTransactions, excluded, errors };
}

// Test-Helper: ausschließlich für Vitest-Suites verwendet.
export const __testing = { buildExcelKeySet };
// storage import bewahrt die etablierte Service-Schicht-Kopplung (für
// zukünftige Wiederverwendung von z.B. soft-delete-Helfern).
void storage;
