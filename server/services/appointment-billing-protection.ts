/**
 * Task #1602 — Gemeinsame SSoT: "Ist dieser Termin gegen Mutation geschützt,
 * weil er bereits abgerechnet ist?"
 *
 * Ein Termin gilt als geschützt, wenn er
 *   (a) an einem NICHT soft-gelöschten, employee- ODER customer-signierten
 *       `monthly_service_records` (Leistungsnachweis) hängt, ODER
 *   (b) als Line-Item auf einer NICHT-stornierten Rechnung auftaucht, die
 *       selbst keine Stornorechnung ist (`status != 'storniert'` UND
 *       `invoice_type != 'stornorechnung'`).
 *
 * Diese Funktion konsolidiert zwei bislang getrennt implementierte Prüfungen:
 *   - die inline im Reconcile-Pfad liegende signierte-LN-Query
 *     (`appointment-import-reconcile.ts`), und
 *   - die rechnungs-seitige Logik aus `getAlreadyInvoicedAppointmentIds`
 *     (`invoice-data.ts`, `invoice_line_items`-Join).
 *
 * Sowohl der Haupt-Import (`appointment-import.ts`, `update`-Pfad) als auch der
 * Reconcile-Pfad nutzen jetzt DIESE Funktion. Der Reconcile-Pfad konsumiert
 * bewusst weiterhin nur `signedServiceRecordIds` (Verhalten unverändert), der
 * Import-Pfad nutzt die vereinigte Menge `protectedIds`.
 *
 * Entwurfs-Rechnungen (`status = 'entwurf'`) sind absichtlich EINGESCHLOSSEN:
 * ein Termin auf einer noch nicht versendeten Entwurfs-Rechnung ist bereits
 * abgerechnet (die `!= 'storniert'`-Bedingung schließt `entwurf` mit ein,
 * analog `invoice-data.ts`).
 */

import { and, eq, inArray, isNull, isNotNull, ne, or } from "drizzle-orm";
import {
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import { db, type DbOrTx } from "../lib/db";

export interface AppointmentProtectionResult {
  /** Vereinigung aller geschützten Termin-IDs ((a) ODER (b)). */
  protectedIds: Set<number>;
  /** Teilmenge: geschützt durch signierten (employee ODER customer) Leistungsnachweis. */
  signedServiceRecordIds: Set<number>;
  /** Teilmenge: geschützt durch eine nicht-stornierte / nicht-Stornorechnungs-Rechnung. */
  invoicedIds: Set<number>;
}

/**
 * Gibt für eine Menge von Termin-IDs zurück, welche gegen mutierende
 * Import-Operationen (Update/Rebook) geschützt sind, weil sie bereits
 * abgerechnet sind.
 *
 * @param appointmentIds Zu prüfende Termin-IDs.
 * @param txClient Optionaler Transaktions-/DB-Client (Reconcile ruft dies
 *   innerhalb seiner all-or-nothing-Transaktion auf, damit Schutz-Read und
 *   Mutation denselben Snapshot sehen).
 */
export async function getMutationProtectedAppointmentIds(
  appointmentIds: number[],
  txClient?: DbOrTx,
): Promise<AppointmentProtectionResult> {
  const signedServiceRecordIds = new Set<number>();
  const invoicedIds = new Set<number>();
  const protectedIds = new Set<number>();

  if (appointmentIds.length === 0) {
    return { protectedIds, signedServiceRecordIds, invoicedIds };
  }

  const executor = txClient ?? db;

  // (a) Signierter Leistungsnachweis (employee ODER customer signiert),
  //     nicht soft-gelöscht.
  const signedRows = await executor
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .innerJoin(
      monthlyServiceRecords,
      eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
    )
    .where(
      and(
        inArray(serviceRecordAppointments.appointmentId, appointmentIds),
        isNull(monthlyServiceRecords.deletedAt),
        or(
          isNotNull(monthlyServiceRecords.employeeSignedAt),
          isNotNull(monthlyServiceRecords.customerSignedAt),
        ),
      ),
    );
  for (const r of signedRows) {
    signedServiceRecordIds.add(r.appointmentId);
    protectedIds.add(r.appointmentId);
  }

  // (b) Auf einer nicht-stornierten / nicht-Stornorechnungs-Rechnung
  //     als Line-Item — schließt Entwurfs-Rechnungen bewusst mit ein.
  const invoicedRows = await executor
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(
      and(
        inArray(invoiceLineItems.appointmentId, appointmentIds),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ),
    );
  for (const r of invoicedRows) {
    if (r.appointmentId == null) continue;
    invoicedIds.add(r.appointmentId);
    protectedIds.add(r.appointmentId);
  }

  return { protectedIds, signedServiceRecordIds, invoicedIds };
}
