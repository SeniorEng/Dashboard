import {
  type MonthlyServiceRecord,
  type InsertServiceRecord,
  type ServiceRecordStatus,
  customers,
  prospects,
  appointments,
  monthlyServiceRecords,
  serviceRecordAppointments,
  invoices as invoicesTable,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { UNDOCUMENTED_STATUSES } from "@shared/domain/appointments";
import { computeDataHash } from "../services/signature-integrity";
import { analyzeSignatureImage } from "../lib/signature-validation";
import { eq, sql as sqlBuilder, ne, and, or, inArray, isNull, type SQL, type SQLWrapper } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";

function employeeFilter(employeeId: number): SQL {
  return sqlBuilder`(${appointments.assignedEmployeeId} = ${employeeId} OR ${appointments.performedByEmployeeId} = ${employeeId})`;
}
import { getAssignedCustomerIds, getPrimaryCustomerIds } from "./customers-storage";
import type { ServiceRecordOverviewItem } from "../storage";
import { appointmentsRepo, customersRepo, monthlyServiceRecordsRepo } from "../repos";

export async function getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number, customerId?: number): Promise<MonthlyServiceRecord[]> {
  const primaryCustomerIds = await getPrimaryCustomerIds(employeeId);
  const primarySet = new Set(primaryCustomerIds);

  const baseConditions: SQLWrapper[] = [isNull(monthlyServiceRecords.deletedAt)];
  if (year !== undefined) {
    baseConditions.push(eq(monthlyServiceRecords.year, year));
  }
  if (month !== undefined) {
    baseConditions.push(eq(monthlyServiceRecords.month, month));
  }
  if (customerId !== undefined) {
    baseConditions.push(eq(monthlyServiceRecords.customerId, customerId));
    const isPrimary = primarySet.has(customerId);
    if (!isPrimary) {
      baseConditions.push(eq(monthlyServiceRecords.employeeId, employeeId));
    }
  } else {
    const assignedCustomerIds = await getAssignedCustomerIds(employeeId);
    if (assignedCustomerIds.length === 0) return [];
    const backupCustomerIds = assignedCustomerIds.filter(id => !primarySet.has(id));

    const orConditions: SQLWrapper[] = [];
    if (primaryCustomerIds.length > 0) {
      orConditions.push(inArray(monthlyServiceRecords.customerId, primaryCustomerIds));
    }
    if (backupCustomerIds.length > 0) {
      const backupCondition = and(
        eq(monthlyServiceRecords.employeeId, employeeId),
        inArray(monthlyServiceRecords.customerId, backupCustomerIds),
      );
      if (backupCondition) orConditions.push(backupCondition);
    }
    if (orConditions.length > 0) {
      const combined = or(...orConditions);
      if (combined) baseConditions.push(combined);
    } else {
      return [];
    }
  }
  return await monthlyServiceRecordsRepo.selectFrom(db)
    .where(and(...baseConditions))
    .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
}

export async function getServiceRecordsForCustomer(customerId: number): Promise<MonthlyServiceRecord[]> {
  return await monthlyServiceRecordsRepo.selectFrom(db)
    .where(and(eq(monthlyServiceRecords.customerId, customerId), isNull(monthlyServiceRecords.deletedAt)))
    .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
}

export async function getServiceRecord(id: number): Promise<MonthlyServiceRecord | undefined> {
  const result = await monthlyServiceRecordsRepo.selectFrom(db)
    .where(and(eq(monthlyServiceRecords.id, id), isNull(monthlyServiceRecords.deletedAt)));
  return result[0];
}

export async function getServiceRecordByPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<MonthlyServiceRecord | undefined> {
  const conditions: SQLWrapper[] = [
    eq(monthlyServiceRecords.customerId, customerId),
    eq(monthlyServiceRecords.year, year),
    eq(monthlyServiceRecords.month, month),
    eq(monthlyServiceRecords.recordType, "monthly"),
    isNull(monthlyServiceRecords.deletedAt),
  ];
  if (!isPrimary) {
    conditions.push(eq(monthlyServiceRecords.employeeId, employeeId));
  }
  const result = await monthlyServiceRecordsRepo.selectFrom(db)
    .where(and(...conditions));
  return result[0];
}

export async function createServiceRecord(record: InsertServiceRecord, txClient?: DbOrTx): Promise<MonthlyServiceRecord> {
  const executor = txClient ?? db;
  const result = await executor.insert(monthlyServiceRecords)
    .values({
      customerId: record.customerId,
      employeeId: record.employeeId,
      year: record.year,
      month: record.month,
      recordType: record.recordType ?? "monthly",
      status: "pending",
    })
    .returning();
  return result[0];
}

/**
 * Task #749 — Thrown by `signServiceRecord` when the supplied signature
 * image fails the meaningful-pixel check (empty/transparent canvas,
 * mini-canvas race, etc.). The HTTP route surfaces this as a 400 with
 * the German message; the service record stays in its previous status.
 */
export class EmptySignatureError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EmptySignatureError";
    this.code = code;
  }
}

/**
 * Task #749 — Cache-Invalidierung für Kunde/Jahr/Monat.
 *
 * Ändert sich der Inhalt eines Leistungsnachweises (Unterschriftslage ODER —
 * seit #1892 — die Menge der enthaltenen Termine), können sowohl das
 * Leistungsnachweis-PDF als auch das Rechnungs-PDF/ZUGFeRD-XML dieser Periode
 * veraltet sein (der LN ist Anlage zur Rechnung). Wir nullen die Cache-Felder
 * der betroffenen Rechnungen, damit der nächste Abruf frisch rendert.
 *
 * GoBD: NUR Rechnungen im Entwurfs-Status werden angefasst. Versendete
 * (`versendet`), bezahlte (`bezahlt`) und stornierte (`storniert`) Rechnungen
 * bleiben UNANGETASTET — Korrektur dort ausschließlich über Storno +
 * Neuanlage (siehe docs/deployment-log.md, RE-2026-0010-Runbook).
 *
 * Die eine Stelle, an der diese Invalidierung formuliert ist: Unterschrift
 * (`signServiceRecord`) und Termin-Entfernung
 * (`removeAppointmentFromServiceRecords`) rufen dieselbe Funktion.
 */
export async function invalidateDraftInvoicePdfCache(
  client: DbOrTx,
  scope: { customerId: number; year: number; month: number },
): Promise<void> {
  await client.update(invoicesTable)
    .set({
      leistungsnachweisPath: null,
      leistungsnachweisHash: null,
      leistungsnachweisDataFingerprint: null,
      pdfPath: null,
      pdfHash: null,
      pdfDataFingerprint: null,
    })
    .where(and(
      eq(invoicesTable.customerId, scope.customerId),
      eq(invoicesTable.billingYear, scope.year),
      eq(invoicesTable.billingMonth, scope.month),
      eq(invoicesTable.status, "entwurf"),
    ));
}

export async function signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer', userId?: number, signingIp?: string | null, signingLocation?: string | null): Promise<MonthlyServiceRecord | undefined> {
  const existing = await getServiceRecord(id);
  if (!existing) return undefined;

  // Task #749 — Bevor wir Status oder Signatur persistieren, prüfen ob das
  // übergebene Bild tatsächlich eine sichtbare Unterschrift trägt. Damit
  // verhindern wir, dass ein Service-Record auf `completed` rutscht, dessen
  // customerSignatureData im Leistungsnachweis-PDF als leeres <img> rendert
  // (Hauptfehler-Pfad aus RE-2026-0010).
  const validation = analyzeSignatureImage(signatureData);
  if (!validation.ok) {
    throw new EmptySignatureError(validation.reason, validation.code);
  }

  const now = new Date();
  const hash = computeDataHash(signatureData);

  let expectedStatus: ServiceRecordStatus;
  let nextStatus: ServiceRecordStatus;
  let outOfOrderMessage: string;
  let signatureFields: Partial<MonthlyServiceRecord>;

  if (signerType === 'employee') {
    expectedStatus = 'pending' as ServiceRecordStatus;
    outOfOrderMessage = 'Mitarbeiter kann nur bei Status "pending" unterschreiben';
    if (existing.status !== expectedStatus) {
      throw new Error(outOfOrderMessage);
    }
    nextStatus = 'employee_signed' as ServiceRecordStatus;
    signatureFields = {
      employeeSignatureData: signatureData,
      employeeSignatureHash: hash,
      employeeSignedAt: now,
      employeeSignedByUserId: userId ?? null,
      employeeSigningIp: signingIp ?? null,
      employeeSigningLocation: signingLocation ?? null,
    };
  } else if (signerType === 'customer') {
    expectedStatus = 'employee_signed' as ServiceRecordStatus;
    outOfOrderMessage = 'Kunde kann nur nach Mitarbeiter-Unterschrift unterschreiben';
    if (existing.status !== expectedStatus) {
      throw new Error(outOfOrderMessage);
    }
    nextStatus = 'completed' as ServiceRecordStatus;
    signatureFields = {
      customerSignatureData: signatureData,
      customerSignatureHash: hash,
      customerSignedAt: now,
      customerSignedByUserId: userId ?? null,
      customerSigningIp: signingIp ?? null,
      customerSigningLocation: signingLocation ?? null,
    };
  } else {
    return undefined;
  }

  return await db.transaction(async (tx) => {
    // Atomarer Status-Übergang (Task #1529): Der Status wird in EINEM
    // bedingten UPDATE geschrieben, das nur greift, solange der Datensatz noch
    // im erwarteten Ausgangsstatus steht (`status = expectedStatus`). Damit
    // kann eine zweite, fast zeitgleiche Unterschrift den Übergang nicht
    // doppelt oder out-of-order anwenden — das frühere Read-then-Write
    // (erst lesen, dann ohne Guard schreiben) war hier rennanfällig.
    // 0 betroffene Zeilen ⇒ ein paralleler Request hat den Übergang bereits
    // vollzogen; wir behandeln das wie den normalen Out-of-Order-Fehler.
    const result = await tx.update(monthlyServiceRecords)
      .set({ ...signatureFields, status: nextStatus, updatedAt: now })
      .where(and(
        eq(monthlyServiceRecords.id, id),
        eq(monthlyServiceRecords.status, expectedStatus),
      ))
      .returning();

    if (result.length === 0) {
      throw new Error(outOfOrderMessage);
    }

    await invalidateDraftInvoicePdfCache(tx, {
      customerId: existing.customerId,
      year: existing.year,
      month: existing.month,
    });

    return result[0];
  });
}

export async function updateServiceRecord(id: number, data: Partial<typeof monthlyServiceRecords.$inferInsert>): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.update(monthlyServiceRecords)
    .set(data)
    .where(eq(monthlyServiceRecords.id, id))
    .returning();
  return result[0];
}

export async function getAppointmentsForServiceRecord(serviceRecordId: number): Promise<AppointmentWithCustomer[]> {
  const linkedAppointments = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, serviceRecordId));

  if (linkedAppointments.length === 0) return [];

  const appointmentIds = linkedAppointments.map(la => la.appointmentId);

  const rows = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(inArray(appointments.id, appointmentIds), isNull(appointments.deletedAt)))
    .orderBy(appointments.date, appointments.scheduledStart);

  return rows.map(mapAppointmentRow);
}

export async function addAppointmentsToServiceRecord(serviceRecordId: number, appointmentIds: number[], txClient?: DbOrTx): Promise<void> {
  if (appointmentIds.length === 0) return;
  const executor = txClient ?? db;

  const values = appointmentIds.map(appointmentId => ({
    serviceRecordId,
    appointmentId,
  }));

  await executor.insert(serviceRecordAppointments)
    .values(values)
    .onConflictDoNothing();
}

function getAppointmentsForPeriodBase(
  customerId: number,
  employeeId: number,
  year: number,
  month: number,
  statusConditions: SQLWrapper[],
  isPrimary?: boolean,
): Promise<AppointmentWithCustomer[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const conditions: SQLWrapper[] = [
    eq(appointments.customerId, customerId),
    ...statusConditions,
    sqlBuilder`${appointments.date} >= ${startDate}`,
    sqlBuilder`${appointments.date} < ${endDate}`,
    isNull(appointments.deletedAt),
  ];
  if (!isPrimary) {
    conditions.push(employeeFilter(employeeId));
  }

  return appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions))
    .orderBy(appointments.date, appointments.scheduledStart)
    .then(rows => rows.map(mapAppointmentRow));
}

export function getDocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<AppointmentWithCustomer[]> {
  return getAppointmentsForPeriodBase(customerId, employeeId, year, month, [eq(appointments.status, 'completed')], isPrimary);
}

export function getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<AppointmentWithCustomer[]> {
  // „Undokumentiert" = der Termin wartet noch auf eine Mitarbeiter-Handlung
  // (geplant oder in Dokumentation). Terminal-Status — `completed`,
  // `cancelled` UND `customer_no_show` — gehören NICHT hierher. No-Shows sind
  // bewusst kein To-do (Task #1518); sie würden sonst sowohl die
  // LN-Erstellung blockieren als auch in der „Offene Termine"-Liste auftauchen.
  // Positiv gefiltert über UNDOCUMENTED_STATUSES, damit diese Liste deckungs-
  // gleich mit `getAppointmentCountsForPeriod.undocumentedCount` bleibt.
  return getAppointmentsForPeriodBase(customerId, employeeId, year, month, [inArray(appointments.status, UNDOCUMENTED_STATUSES)], isPrimary);
}

/**
 * No-Show-Termine eines Kunden im Monat — rein informativ (Task #1518).
 *
 * Diese Termine erzeugen KEINEN Leistungsnachweis und sind kein To-do; sie
 * werden ausschließlich für die Büro-/Admin-Anzeige geladen, damit
 * nachvollziehbar bleibt, warum an einem Tag „nichts passiert" ist. Die
 * Abrechnungslogik (private „Vergebliche Anfahrt" für Selbstzahler) bleibt
 * unberührt.
 */
export function getNoShowAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<AppointmentWithCustomer[]> {
  return getAppointmentsForPeriodBase(customerId, employeeId, year, month, [eq(appointments.status, 'customer_no_show')], isPrimary);
}

export async function getPendingServiceRecords(employeeId: number): Promise<MonthlyServiceRecord[]> {
  const [primaryCustomerIds, assignedCustomerIds] = await Promise.all([
    getPrimaryCustomerIds(employeeId),
    getAssignedCustomerIds(employeeId),
  ]);
  if (assignedCustomerIds.length === 0) return [];
  const primarySet = new Set(primaryCustomerIds);
  const backupCustomerIds = assignedCustomerIds.filter(id => !primarySet.has(id));

  const conditions: SQLWrapper[] = [
    ne(monthlyServiceRecords.status, 'completed'),
    isNull(monthlyServiceRecords.deletedAt),
  ];

  const orConditions: SQLWrapper[] = [];
  if (primaryCustomerIds.length > 0) {
    orConditions.push(inArray(monthlyServiceRecords.customerId, primaryCustomerIds));
  }
  if (backupCustomerIds.length > 0) {
    const backupCondition = and(
      eq(monthlyServiceRecords.employeeId, employeeId),
      inArray(monthlyServiceRecords.customerId, backupCustomerIds),
    );
    if (backupCondition) orConditions.push(backupCondition);
  }
  if (orConditions.length > 0) {
    const combined = or(...orConditions);
    if (combined) conditions.push(combined);
  } else {
    return [];
  }

  return await monthlyServiceRecordsRepo.selectFrom(db)
    .where(and(...conditions))
    .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
}

export async function getAppointmentIdsInServiceRecords(appointmentIds: number[], txClient?: DbOrTx): Promise<number[]> {
  if (appointmentIds.length === 0) return [];
  const executor = txClient ?? db;
  const rows = await executor.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      inArray(serviceRecordAppointments.appointmentId, appointmentIds),
      isNull(monthlyServiceRecords.deletedAt)
    ));
  return rows.map(r => r.appointmentId);
}

/**
 * Task #1542 — Race-Safe Coverage-Ausschluss.
 *
 * Sperrt die zu bündelnden Termin-Zeilen mit `FOR UPDATE` (aufsteigend nach id,
 * um Deadlocks zu vermeiden). Da der Coverage-Ausschluss global pro Termin gilt
 * (ein Termin darf in genau EINEM aktiven LN liegen — unabhängig vom
 * Mitarbeiter), serialisiert das Sperren der Termin-Zeilen zwei gleichzeitige
 * Sammel-LN-Creates, die denselben Termin beanspruchen. Der Aufrufer prüft danach
 * INNERHALB derselben Transaktion erneut die Abdeckung (getAppointmentIdsIn-
 * ServiceRecords mit tx) und bricht ab, falls der Termin zwischenzeitlich
 * abgedeckt wurde. MUSS mit einem Transaktions-Client aufgerufen werden.
 */
export async function lockAppointmentsForUpdate(appointmentIds: number[], txClient: DbOrTx): Promise<void> {
  if (appointmentIds.length === 0) return;
  const ordered = [...new Set(appointmentIds)].sort((a, b) => a - b);
  // Repo-vermittelter Read (Soft-Delete-Guard), aber BEWUSST OHNE `activeOnly()`:
  // Dies ist ein ID-gezielter FOR-UPDATE-Lock auf einen bereits upstream
  // ermittelten Termin-Satz, kein Listing. Ein eventuell soft-gelöschter Termin
  // in `appointmentIds` MUSS trotzdem gelockt werden, damit konkurrierende
  // Service-Record-Läufe deterministisch serialisiert werden (Lock-Semantik
  // exakt erhalten: inArray → orderBy(id) → for("update")).
  await appointmentsRepo.selectColumnsFrom({ id: appointments.id }, txClient)
    .where(inArray(appointments.id, ordered))
    .orderBy(appointments.id)
    .for("update");
}

/**
 * Task #1544 — Race-sichere Lock-Prüfung INNERHALB einer Mutations-Transaktion.
 *
 * `isAppointmentLocked` läuft heute außerhalb der Transaktion (check-then-write).
 * Zwischen dieser Prüfung und dem eigentlichen Edit/Delete kann eine gleichzeitige
 * Mitarbeiter-/Kunden-Unterschrift den Sammel-LN versiegeln. Weil die junction
 * `service_record_appointments` ON DELETE CASCADE ist, würde ein Delete danach
 * einen bereits versiegelten (GoBD-)Nachweis mutieren — Verstoß gegen die
 * Invariante „einmal unterschrieben = unveränderlich".
 *
 * Diese Funktion schließt das Fenster:
 *   1) Sie sperrt die Termin-Zeile selbst mit FOR UPDATE (`lockAppointmentsForUpdate`),
 *      wodurch sie gegen eine gleichzeitig laufende LN-Erstellung (die dieselbe
 *      Termin-Zeile sperrt) serialisiert.
 *   2) Sie sperrt die verknüpften `monthly_service_records`-Zeilen mit FOR UPDATE
 *      und wertet den Lock-Status ERNEUT aus. Da die Unterschrift denselben
 *      Datensatz per bedingtem UPDATE sperrt (siehe `signServiceRecord`),
 *      serialisiert dieser Lock die Termin-Mutation gegen die Unterschrift:
 *        - Unterschrift committet zuerst → Re-Check liefert `true` → Mutation
 *          bricht ab (Aufrufer wirft/antwortet mit APPOINTMENT_LOCKED).
 *        - Mutation committet zuerst → Unterschrift läuft auf dem (noch nicht
 *          versiegelten) Datensatz weiter; das Entfernen eines Termins VOR der
 *          Versiegelung ist zulässig.
 *
 * MUSS innerhalb einer Transaktion aufgerufen werden.
 */
export async function lockAndCheckAppointmentLocked(
  appointmentId: number,
  txClient: DbOrTx,
): Promise<boolean> {
  await lockAppointmentsForUpdate([appointmentId], txClient);

  const rows = await txClient.select({
    status: monthlyServiceRecords.status,
  })
    .from(serviceRecordAppointments)
    .innerJoin(
      monthlyServiceRecords,
      eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
    )
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt),
    ))
    .for("update");

  return rows.some(
    (r) => r.status === "employee_signed" || r.status === "completed",
  );
}

/** Ergebnis einer Termin-Entfernung je betroffenem Leistungsnachweis. */
export interface ServiceRecordAppointmentRemoval {
  recordId: number;
  customerId: number;
  employeeId: number;
  year: number;
  month: number;
  /** Status VOR der Entfernung — bleibt durch die Entfernung unverändert. */
  status: ServiceRecordStatus;
  /** Der LN enthielt danach keinen Termin mehr und wurde soft-gelöscht. */
  becameEmpty: boolean;
  /** Verbliebene Termine nach der Entfernung. */
  remainingAppointments: number;
}

/**
 * Task #1892 — Admin-Korrektur: einen Termin aus ALLEN verknüpften, nicht
 * gelöschten Leistungsnachweisen herauslösen.
 *
 * REDUKTIONS-ONLY: die Operation entfernt ausschließlich; sie fügt nie etwas
 * hinzu und erhöht nie einen Wert. Status und BEIDE Unterschriften des LN
 * bleiben unangetastet — der Nachweis bleibt gültig, nur mit einem Termin (und
 * entsprechend weniger Wert) weniger. Das ist zulässig, weil der LN on-demand
 * rendert und die Signatur-Hashes das Unterschrifts-BILD hashen, nicht den
 * Inhalt.
 *
 * MUSS innerhalb der Lösch-Transaktion und NACH
 * `lockAndCheckAppointmentLocked` laufen — dessen FOR-UPDATE-Lock auf Termin-
 * und LN-Zeilen serialisiert diese Mutation gegen eine gleichzeitig
 * committende Unterschrift. Wir sperren die LN-Zeilen hier erneut mit
 * FOR UPDATE, damit die Funktion auch für sich genommen lock-sauber ist
 * (derselbe Lock, kein zusätzliches Fenster).
 *
 * Wird ein LN durch die Entfernung leer, ergibt er keinen Nachweis mehr und
 * wird soft-gelöscht (`deleted_at`) — hart gelöscht wird nie.
 *
 * Der Aufrufer MUSS vorher sicherstellen, dass der Termin auf keiner AKTIVEN
 * Rechnung liegt (`hasActiveInvoiceForAppointments`) — GoBD: Storno first.
 */
export async function removeAppointmentFromServiceRecords(
  appointmentId: number,
  txClient: Tx,
): Promise<ServiceRecordAppointmentRemoval[]> {
  const linked = await txClient.select({
    recordId: monthlyServiceRecords.id,
    customerId: monthlyServiceRecords.customerId,
    employeeId: monthlyServiceRecords.employeeId,
    year: monthlyServiceRecords.year,
    month: monthlyServiceRecords.month,
    status: monthlyServiceRecords.status,
  })
    .from(serviceRecordAppointments)
    .innerJoin(
      monthlyServiceRecords,
      eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
    )
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt),
    ))
    .for("update");

  if (linked.length === 0) return [];

  // Die Verknüpfung lösen — NUR für diesen Termin.
  await txClient.delete(serviceRecordAppointments)
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      inArray(serviceRecordAppointments.serviceRecordId, linked.map((l) => l.recordId)),
    ));

  const removals: ServiceRecordAppointmentRemoval[] = [];
  const now = new Date();

  for (const record of linked) {
    const remaining = await txClient.select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, record.recordId));

    const becameEmpty = remaining.length === 0;
    if (becameEmpty) {
      await txClient.update(monthlyServiceRecords)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(monthlyServiceRecords.id, record.recordId));
    } else {
      // Inhalt geändert ⇒ `updated_at` mitziehen. Status und Unterschriften
      // bleiben bewusst unberührt (reduktions-only, kein neuer LN-Status).
      await txClient.update(monthlyServiceRecords)
        .set({ updatedAt: now })
        .where(eq(monthlyServiceRecords.id, record.recordId));
    }

    // Dieselbe Invalidierung wie beim Signieren — der LN ist Anlage zur
    // Rechnung, sein Inhalt hat sich geändert.
    await invalidateDraftInvoicePdfCache(txClient, {
      customerId: record.customerId,
      year: record.year,
      month: record.month,
    });

    removals.push({
      recordId: record.recordId,
      customerId: record.customerId,
      employeeId: record.employeeId,
      year: record.year,
      month: record.month,
      status: record.status as ServiceRecordStatus,
      becameEmpty,
      remainingAppointments: remaining.length,
    });
  }

  return removals;
}

export async function getServiceRecordForAppointment(appointmentId: number): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.select({ record: monthlyServiceRecords })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt)
    ))
    .limit(1);
  return result[0]?.record;
}

export async function isAppointmentLocked(appointmentId: number): Promise<boolean> {
  const result = await db.select({
    serviceRecordId: serviceRecordAppointments.serviceRecordId,
    status: monthlyServiceRecords.status,
  })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt),
      or(
        eq(monthlyServiceRecords.status, 'employee_signed'),
        eq(monthlyServiceRecords.status, 'completed')
      )
    ))
    .limit(1);

  return result.length > 0;
}

export async function getServiceRecordsOverview(employeeId: number, year: number, month: number): Promise<ServiceRecordOverviewItem[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const [assignedCustomerIds, primaryCustomerIds] = await Promise.all([
    getAssignedCustomerIds(employeeId),
    getPrimaryCustomerIds(employeeId),
  ]);
  if (assignedCustomerIds.length === 0) {
    return [];
  }
  const primarySet = new Set(primaryCustomerIds);
  const backupCustomerIds = assignedCustomerIds.filter(id => !primarySet.has(id));

  const dateConditions = [
    sqlBuilder`${appointments.date} >= ${startDate}`,
    sqlBuilder`${appointments.date} < ${endDate}`,
    ne(appointments.status, 'cancelled'),
    isNull(appointments.deletedAt),
  ];

  const primaryOverview = primaryCustomerIds.length > 0 ? await customersRepo.selectColumnsFrom({
    customerId: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
    documentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
    undocumentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} IN ('scheduled', 'documenting') THEN 1 ELSE 0 END), 0)::int`,
    totalAppointments: sqlBuilder<number>`COUNT(${appointments.id})::int`,
  }, db)
    .leftJoin(appointments, and(
      eq(appointments.customerId, customers.id),
      ...dateConditions,
    ))
    .where(inArray(customers.id, primaryCustomerIds))
    .groupBy(customers.id, customers.vorname, customers.nachname) : [];

  const backupOverview = backupCustomerIds.length > 0 ? await customersRepo.selectColumnsFrom({
    customerId: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
    documentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
    undocumentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} IN ('scheduled', 'documenting') THEN 1 ELSE 0 END), 0)::int`,
    totalAppointments: sqlBuilder<number>`COUNT(${appointments.id})::int`,
  }, db)
    .leftJoin(appointments, and(
      eq(appointments.customerId, customers.id),
      or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.performedByEmployeeId, employeeId)
      ),
      ...dateConditions,
    ))
    .where(inArray(customers.id, backupCustomerIds))
    .groupBy(customers.id, customers.vorname, customers.nachname) : [];

  const overviewData = [...primaryOverview, ...backupOverview];

  const recordConditions = [
    eq(monthlyServiceRecords.year, year),
    eq(monthlyServiceRecords.month, month),
    isNull(monthlyServiceRecords.deletedAt),
  ];

  const primaryRecords = primaryCustomerIds.length > 0 ? await monthlyServiceRecordsRepo.selectColumnsFrom({
    customerId: monthlyServiceRecords.customerId,
    id: monthlyServiceRecords.id,
    status: monthlyServiceRecords.status,
    recordType: monthlyServiceRecords.recordType,
  }, db)
    .where(and(
      inArray(monthlyServiceRecords.customerId, primaryCustomerIds),
      ...recordConditions,
    )) : [];

  const backupRecords = backupCustomerIds.length > 0 ? await monthlyServiceRecordsRepo.selectColumnsFrom({
    customerId: monthlyServiceRecords.customerId,
    id: monthlyServiceRecords.id,
    status: monthlyServiceRecords.status,
    recordType: monthlyServiceRecords.recordType,
  }, db)
    .where(and(
      eq(monthlyServiceRecords.employeeId, employeeId),
      inArray(monthlyServiceRecords.customerId, backupCustomerIds),
      ...recordConditions,
    )) : [];

  const existingRecords = [...primaryRecords, ...backupRecords];

  const monthlyRecordsMap = new Map<number, { id: number; status: string }[]>();
  const singleRecordsMap = new Map<number, { id: number; status: string; recordType: string }[]>();

  for (const r of existingRecords) {
    if (r.recordType === "monthly") {
      const existing = monthlyRecordsMap.get(r.customerId) ?? [];
      existing.push({ id: r.id, status: r.status });
      monthlyRecordsMap.set(r.customerId, existing);
    } else {
      const existing = singleRecordsMap.get(r.customerId) ?? [];
      existing.push({ id: r.id, status: r.status, recordType: r.recordType });
      singleRecordsMap.set(r.customerId, existing);
    }
  }

  const customerHasAnyRecord = new Set(existingRecords.map(r => r.customerId));

  const allRecordIds = existingRecords.map(r => r.id);

  let coveredBySingleByCustomer = new Map<number, number>();
  let coveredByMonthlyByCustomer = new Map<number, number>();

  if (allRecordIds.length > 0) {
    const coveredRows = await db.select({
      customerId: appointments.customerId,
      recordType: monthlyServiceRecords.recordType,
      count: sqlBuilder<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
    })
      .from(serviceRecordAppointments)
      .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
      .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
      .where(inArray(serviceRecordAppointments.serviceRecordId, allRecordIds))
      .groupBy(appointments.customerId, monthlyServiceRecords.recordType);

    for (const row of coveredRows) {
      if (row.recordType === "single") {
        coveredBySingleByCustomer.set(row.customerId!, row.count);
      } else {
        coveredByMonthlyByCustomer.set(row.customerId!, row.count);
      }
    }
  }

  return overviewData
    .filter(item => item.totalAppointments > 0 || customerHasAnyRecord.has(item.customerId))
    .map(item => {
      const monthlyRecords = (monthlyRecordsMap.get(item.customerId) ?? [])
        .slice()
        .sort((a, b) => a.id - b.id);
      const singleRecords = singleRecordsMap.get(item.customerId) ?? [];
      const coveredBySingleCount = coveredBySingleByCustomer.get(item.customerId) ?? 0;
      const coveredByMonthlyCount = coveredByMonthlyByCustomer.get(item.customerId) ?? 0;
      return {
        customerId: item.customerId,
        customerName: `${item.vorname} ${item.nachname}`,
        monthlyRecords,
        singleRecords,
        documentedCount: item.documentedCount,
        undocumentedCount: item.undocumentedCount,
        totalAppointments: item.totalAppointments,
        coveredBySingleCount,
        coveredByMonthlyCount,
      };
    });
}

export async function getAppointmentCountsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<{ documentedCount: number; undocumentedCount: number }> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const conditions: SQLWrapper[] = [
    eq(appointments.customerId, customerId),
    ne(appointments.status, 'cancelled'),
    sqlBuilder`${appointments.date} >= ${startDate}`,
    sqlBuilder`${appointments.date} < ${endDate}`,
    isNull(appointments.deletedAt),
  ];
  if (!isPrimary) {
    conditions.push(employeeFilter(employeeId));
  }

  const result = await appointmentsRepo.selectColumnsFrom({
    documentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
    undocumentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} IN ('scheduled', 'documenting') THEN 1 ELSE 0 END), 0)::int`,
  }, db)
    .where(and(...conditions));

  return {
    documentedCount: result[0]?.documentedCount ?? 0,
    undocumentedCount: result[0]?.undocumentedCount ?? 0,
  };
}

async function getCoveredByRecordTypeCount(recordType: "single" | "monthly", customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<number> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const conditions: SQLWrapper[] = [
    eq(monthlyServiceRecords.recordType, recordType),
    eq(appointments.customerId, customerId),
    sqlBuilder`${appointments.date} >= ${startDate}`,
    sqlBuilder`${appointments.date} < ${endDate}`,
    isNull(monthlyServiceRecords.deletedAt),
    isNull(appointments.deletedAt),
  ];
  if (!isPrimary) {
    conditions.push(employeeFilter(employeeId));
  }

  const result = await db.select({
    count: sqlBuilder<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
  })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
    .where(and(...conditions));

  return result[0]?.count ?? 0;
}

export function getCoveredBySingleCount(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<number> {
  return getCoveredByRecordTypeCount("single", customerId, employeeId, year, month, isPrimary);
}

export function getCoveredByMonthlyCount(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<number> {
  return getCoveredByRecordTypeCount("monthly", customerId, employeeId, year, month, isPrimary);
}
