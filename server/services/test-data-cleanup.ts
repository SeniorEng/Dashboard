// ---------------------------------------------------------------------------
// Test-Data-Cleanup-Service (Task #795)
//
// Zentrale, wiederverwendbare Implementierung der gescopten Test-Daten-Purges.
// Sie ist die Single Source of Truth für die HTTP-Routen in
// `server/routes/admin/test-cleanup.ts` UND den periodischen Safety-Scheduler
// (`server/services/test-data-cleanup-scheduler.ts`).
//
// Vorher lebte die Lösch-Logik ausschließlich in den Route-Handlern und wurde
// nur durch `tests/globalSetup.ts` (per HTTP) getriggert. Wenn ein Testlauf vor
// seinem `afterAll`-Cleanup abgebrochen wurde, wuchsen die Stale-Datensätze bis
// zum nächsten `globalSetup` an (Task #789 räumte einen 3300er-Backlog auf).
// Der Scheduler ruft dieselben gescopten Purges periodisch auf, sodass der
// Stale-Pool nie wieder unkontrolliert wächst.
//
// SICHERHEIT: Alle Funktionen sind in Production ein No-op (siehe
// `assertNotProduction`). Die SQL-Test-Pattern-Filter spiegeln die
// `isTest*`-Heuristiken aus `tests/globalSetup.ts`, sodass NIEMALS echte
// Kunden/Interessenten/User getroffen werden können.
// ---------------------------------------------------------------------------
import { inArray, eq, and, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointmentsRepo, prospectsRepo, customersRepo } from "../repos";
import { customers } from "@shared/schema";
import { appointments, appointmentSeries } from "@shared/schema";
import { invoices, invoiceLineItems } from "@shared/schema";
import { budgetTransactions } from "@shared/schema";
import { prospects } from "@shared/schema";
import { qontoTransactions, paymentAdviceItems } from "@shared/schema";
import { documentDeliveries } from "@shared/schema";
import { users } from "@shared/schema/users";

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// SQL-Test-Pattern-Filter — gespiegelt aus tests/globalSetup.ts (isTest*).
// ---------------------------------------------------------------------------

// Mirror von isTestCustomer(). Unterstriche in LIKE müssen via ESCAPE neutralisiert
// werden (auto_ → 'auto#_%').
export const CUSTOMER_TEST_FILTER = sql`(
  LOWER(${customers.vorname}) LIKE '%test%'
  OR LOWER(${customers.nachname}) LIKE '%test%'
  OR LOWER(${customers.nachname}) LIKE 'auto#_%' ESCAPE '#'
  OR LOWER(${customers.vorname}) LIKE 'sz-%'
  OR LOWER(${customers.vorname}) LIKE 'pv-%'
  OR LOWER(${customers.vorname}) LIKE 'fd-%'
  OR LOWER(${customers.vorname}) LIKE 'eb-%'
  OR LOWER(${customers.vorname}) LIKE 'pg1-%'
  OR LOWER(${customers.vorname}) LIKE 'qs-%'
  OR LOWER(${customers.vorname}) LIKE 'status-%'
  OR LOWER(${customers.nachname}) LIKE 'privat-%'
  OR LOWER(${customers.nachname}) LIKE 'fahrtdienst-%'
  OR LOWER(${customers.nachname}) LIKE 'integ-%'
  OR LOWER(${customers.nachname}) LIKE 'mustermann-%'
  OR LOWER(${customers.nachname}) LIKE 'importtrim-%'
  OR LOWER(${customers.nachname}) LIKE 'notrim-%'
  OR LOWER(${customers.nachname}) LIKE 'reconcile-%'
  OR LOWER(${customers.nachname}) LIKE 'aligned-%'
)`;

// Mirror von isTestProspect().
export const PROSPECT_TEST_FILTER = sql`(
  LOWER(${prospects.vorname}) LIKE '%test%'
  OR LOWER(${prospects.nachname}) LIKE '%test%'
  OR LOWER(${prospects.vorname}) LIKE 'eb-%'
  OR LOWER(${prospects.vorname}) LIKE 'status-%'
  OR LOWER(${prospects.nachname}) LIKE 'eb%'
)`;

// Mirror von isTestUser().
export const USER_TEST_FILTER = sql`(
  LOWER(${users.email}) LIKE '%@test.local'
  OR LOWER(${users.email}) LIKE 'testemp-%'
  OR LOWER(${users.nachname}) LIKE 'testemp#_%' ESCAPE '#'
)`;

// ---------------------------------------------------------------------------
// Kunden-Purge
// ---------------------------------------------------------------------------
export async function purgeCustomerCascade(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(prospects)
      .set({ convertedCustomerId: null })
      .where(eq(prospects.convertedCustomerId, id));

    await tx.update(customers)
      .set({ mergedIntoCustomerId: null })
      .where(eq(customers.mergedIntoCustomerId, id));

    // Hard-delete unten löscht ALLE Appointments dieses Kunden, inkl. bereits
    // soft-gelöschter. FK-Refs auf budgetTransactions.appointmentId und
    // appointments.travelFromAppointmentId müssen daher auch für soft-gelöschte
    // Zeilen aufgeräumt werden — `activeOnly()` würde diese ausschließen und
    // FK-Konflikte beim Hard-Delete provozieren.
    const apptIdsRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id }, tx)
      .where(eq(appointments.customerId, id));
    const apptIds = apptIdsRows.map(r => r.id);

    const invIdsRows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.customerId, id));
    const invIds = invIdsRows.map(r => r.id);

    if (invIds.length > 0) {
      await tx.update(qontoTransactions)
        .set({ matchedInvoiceId: null })
        .where(inArray(qontoTransactions.matchedInvoiceId, invIds));
      await tx.update(paymentAdviceItems)
        .set({ matchedInvoiceId: null })
        .where(inArray(paymentAdviceItems.matchedInvoiceId, invIds));
      await tx.update(invoices)
        .set({ stornierteRechnungId: null })
        .where(inArray(invoices.stornierteRechnungId, invIds));
      await tx.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invIds));
      await tx.delete(invoices).where(eq(invoices.customerId, id));
    }

    await tx.delete(appointmentSeries).where(eq(appointmentSeries.customerId, id));

    if (apptIds.length > 0) {
      await tx.update(budgetTransactions)
        .set({ appointmentId: null })
        .where(inArray(budgetTransactions.appointmentId, apptIds));
      await tx.update(appointments)
        .set({ travelFromAppointmentId: null })
        .where(inArray(appointments.travelFromAppointmentId, apptIds));
      await tx.delete(appointments).where(eq(appointments.customerId, id));
    }

    await tx.delete(documentDeliveries).where(eq(documentDeliveries.customerId, id));
    await tx.delete(budgetTransactions).where(eq(budgetTransactions.customerId, id));

    await tx.delete(customers).where(eq(customers.id, id));
  });
}

export interface PurgeCustomersResult {
  deleted: number[];
  failed: Array<{ id: number; error: string }>;
}

export async function purgeTestCustomersByIds(ids: number[]): Promise<PurgeCustomersResult> {
  const deleted: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  for (const id of ids) {
    try {
      await purgeCustomerCascade(id);
      deleted.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

// Findet alle Kunden, die dem Test-Pattern entsprechen (gescopt). Bewusst OHNE
// activeOnly() — auch soft-gelöschte Test-Kunden sollen hart wegfallen.
export async function findTestCustomerIds(): Promise<number[]> {
  const rows = await customersRepo
    .selectColumnsFrom({ id: customers.id })
    .where(CUSTOMER_TEST_FILTER);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Interessenten-Purge (Task #789)
// ---------------------------------------------------------------------------
// ids optional: ohne ids werden ALLE Test-Interessenten gelöscht (Backlog-Purge).
// Mit ids wird zusätzlich auf diese IDs gescopt. prospect_notes / prospect_offers
// / scheduled_calls hängen per ON DELETE CASCADE dran; appointments.prospect_id
// ist ON DELETE SET NULL, aber der CHECK-Constraint
// `appointments_prospect_or_customer_check` verlangt prospect_id ODER
// customer_id — Erstberatungs-Termine ohne Kunden müssen daher VORHER hart
// gelöscht werden.
export async function purgeTestProspectsByIds(ids?: number[]): Promise<number[]> {
  const where = ids && ids.length > 0
    ? and(inArray(prospects.id, ids), PROSPECT_TEST_FILTER)
    : PROSPECT_TEST_FILTER;

  return db.transaction(async (tx) => {
    const targetRows = await prospectsRepo
      .selectColumnsFrom({ id: prospects.id }, tx)
      .where(where);
    const prospectIds = targetRows.map((r) => r.id);
    if (prospectIds.length === 0) return [];

    const apptRows = await appointmentsRepo
      .selectColumnsFrom({ id: appointments.id }, tx)
      .where(inArray(appointments.prospectId, prospectIds));
    const apptIds = apptRows.map((r) => r.id);

    if (apptIds.length > 0) {
      await tx.update(budgetTransactions)
        .set({ appointmentId: null })
        .where(inArray(budgetTransactions.appointmentId, apptIds));
      await tx.update(invoiceLineItems)
        .set({ appointmentId: null })
        .where(inArray(invoiceLineItems.appointmentId, apptIds));
      await tx.update(appointments)
        .set({ travelFromAppointmentId: null })
        .where(inArray(appointments.travelFromAppointmentId, apptIds));
      // appointment_services + service_records hängen per ON DELETE CASCADE dran.
      await tx.delete(appointments).where(inArray(appointments.id, apptIds));
    }

    // prospect_notes / prospect_offers / scheduled_calls = ON DELETE CASCADE.
    const deletedRows = await tx
      .delete(prospects)
      .where(inArray(prospects.id, prospectIds))
      .returning({ id: prospects.id });
    return deletedRows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------------------
// Test-User-Purge
// ---------------------------------------------------------------------------
export type PurgeUsersResult =
  | { ok: true; deleted: number[]; rejected: number[]; reason?: string }
  | {
      ok: false;
      blocked: true;
      rejected: number[];
      counts: { appt: number; msr: number; cah: number };
      detached: { appointments: number; msr: number; cah: number };
    };

export async function purgeTestUsersByIds(ids: number[]): Promise<PurgeUsersResult> {
  if (ids.length === 0) return { ok: true, deleted: [], rejected: [] };

  // Sicherheits-Filter: nur User mit Test-Pattern wirklich löschen.
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      inArray(users.id, ids),
      sql`(LOWER(${users.email}) LIKE '%@test.local' OR LOWER(${users.email}) LIKE 'testemp-%' OR LOWER(${users.nachname}) LIKE 'testemp#_%' ESCAPE '#')`,
    ));
  const safeIds = testUsers.map((u) => u.id);
  const rejected = ids.filter((i) => !safeIds.includes(i));

  if (safeIds.length === 0) {
    return { ok: true, deleted: [], rejected, reason: "Keine IDs entsprechen dem Test-User-Muster." };
  }

  const idList = sql.join(safeIds.map((i) => sql`${i}`), sql`, `);

  // Pre-Flight-Sicherheitscheck: Test-User dürfen NICHT mit echten Kunden
  // verflochten sein, sonst würden wir bei Hard-Delete von
  // monthly_service_records / customer_assignment_history / aktiven Terminen
  // Daten echter Kunden zerstören.
  const CUSTOMER_TEST_C = sql`(
    LOWER(c.vorname) LIKE '%test%' OR LOWER(c.nachname) LIKE '%test%'
    OR LOWER(c.nachname) LIKE 'auto#_%' ESCAPE '#'
    OR LOWER(c.nachname) LIKE 'privat-%' OR LOWER(c.nachname) LIKE 'fahrtdienst-%' OR LOWER(c.nachname) LIKE 'integ-%'
    OR LOWER(c.vorname) LIKE 'sz-%' OR LOWER(c.vorname) LIKE 'pv-%' OR LOWER(c.vorname) LIKE 'fd-%'
    OR LOWER(c.vorname) LIKE 'eb-%' OR LOWER(c.vorname) LIKE 'pg1-%' OR LOWER(c.vorname) LIKE 'qs-%'
    OR LOWER(c.vorname) LIKE 'status-%'
    OR LOWER(c.nachname) LIKE 'mustermann-%' OR LOWER(c.nachname) LIKE 'importtrim-%'
    OR LOWER(c.nachname) LIKE 'notrim-%' OR LOWER(c.nachname) LIKE 'reconcile-%'
    OR LOWER(c.nachname) LIKE 'aligned-%'
  )`;
  // Detach-Pass (Task #631): Test-User chirurgisch von echten Kunden entkoppeln,
  // BEVOR der Blocker greift, damit der Stale-Pool nicht in einer Sackgasse wächst.
  let detachedAppointments = 0;
  let detachedMsr = 0;
  let detachedCah = 0;
  await db.transaction(async (tx) => {
    const apptRes = await tx.execute(sql`
      UPDATE appointments a SET assigned_employee_id = NULL
      FROM customers c
      WHERE c.id = a.customer_id
        AND a.assigned_employee_id IN (${idList})
        AND NOT ${CUSTOMER_TEST_C}
    `);
    detachedAppointments = (apptRes as unknown as { rowCount?: number }).rowCount ?? 0;

    const msrRes = await tx.execute(sql`
      DELETE FROM monthly_service_records m
      USING customers c
      WHERE c.id = m.customer_id
        AND m.employee_id IN (${idList})
        AND NOT ${CUSTOMER_TEST_C}
    `);
    detachedMsr = (msrRes as unknown as { rowCount?: number }).rowCount ?? 0;

    const cahRes = await tx.execute(sql`
      DELETE FROM customer_assignment_history h
      USING customers c
      WHERE c.id = h.customer_id
        AND h.employee_id IN (${idList})
        AND NOT ${CUSTOMER_TEST_C}
    `);
    detachedCah = (cahRes as unknown as { rowCount?: number }).rowCount ?? 0;
  });

  const blockerRes = await db.execute<{ appt: number; msr: number; cah: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.deleted_at IS NULL AND a.assigned_employee_id IN (${idList})
          AND NOT ${CUSTOMER_TEST_C}) AS appt,
      (SELECT COUNT(*)::int FROM monthly_service_records m JOIN customers c ON c.id = m.customer_id
        WHERE m.employee_id IN (${idList}) AND NOT ${CUSTOMER_TEST_C}) AS msr,
      (SELECT COUNT(*)::int FROM customer_assignment_history h JOIN customers c ON c.id = h.customer_id
        WHERE h.employee_id IN (${idList}) AND NOT ${CUSTOMER_TEST_C}) AS cah
  `);
  const b = (blockerRes as unknown as { rows: Array<{ appt: number; msr: number; cah: number }> }).rows[0];
  if (b.appt > 0 || b.msr > 0 || b.cah > 0) {
    // Sollte nach dem Detach-Pass nie eintreten — Sicherheitsnetz für
    // unerwartete neue FK-Wege (z.B. neue Spalten künftiger Migrationen).
    return {
      ok: false,
      blocked: true,
      rejected: ids,
      counts: { appt: b.appt, msr: b.msr, cah: b.cah },
      detached: { appointments: detachedAppointments, msr: detachedMsr, cah: detachedCah },
    };
  }

  await db.transaction(async (tx) => {
      // GoBD: audit_log ist per BEFORE-Trigger unveränderbar (Task #824). Für
      // diesen — nur in Nicht-Prod erreichbaren — Test-Cleanup-Pfad schalten
      // wir die Mutation transaktions-lokal frei. `SET LOCAL` gilt ausschließlich
      // innerhalb dieser Transaktion und wird beim Commit/Rollback verworfen.
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      // Hard-delete child rows in tables with NO ACTION + non-nullable FK
      await tx.execute(sql`DELETE FROM employee_time_entries WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM notifications WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM employee_month_closings WHERE user_id IN (${idList}) OR closed_by_user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM employee_vacation_allowance WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM user_whatsapp_preferences WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM whatsapp_message_log WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM audit_log WHERE user_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM monthly_service_records WHERE employee_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM customer_assignment_history WHERE employee_id IN (${idList})`);
      await tx.execute(sql`DELETE FROM tasks WHERE created_by_user_id IN (${idList}) OR assigned_to_user_id IN (${idList})`);
      // KEIN DELETE auf appointment_series via assigned_employee_id — würde
      // Serien echter Kunden treffen. Series der Test-Kunden sind bereits über
      // purge-customers weg; verbleibende Series gehören echten Kunden und
      // bekommen unten SET NULL.
      await tx.execute(sql`DELETE FROM employee_compensation_history WHERE created_by_user_id IN (${idList})`);

      // SET NULL on nullable FK refs (NO ACTION rules)
      await tx.execute(sql`UPDATE birthday_card_tracking SET sent_by_user_id = NULL WHERE sent_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE company_settings SET updated_by_user_id = NULL WHERE updated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE system_settings SET updated_by_user_id = NULL WHERE updated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE payment_advices SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE service_rates SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE prospect_notes SET user_id = NULL WHERE user_id IN (${idList})`);
      await tx.execute(sql`UPDATE prospect_offers SET created_by = NULL WHERE created_by IN (${idList})`);
      await tx.execute(sql`UPDATE prospects SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);

      await tx.execute(sql`UPDATE customers SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET primary_employee_id = NULL WHERE primary_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET backup_employee_id = NULL WHERE backup_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customers SET backup_employee_id_2 = NULL WHERE backup_employee_id_2 IN (${idList})`);

      await tx.execute(sql`UPDATE appointments SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET performed_by_employee_id = NULL WHERE performed_by_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointments SET signed_by_user_id = NULL WHERE signed_by_user_id IN (${idList})`);

      await tx.execute(sql`UPDATE appointment_series SET assigned_employee_id = NULL WHERE assigned_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE appointment_series SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);

      await tx.execute(sql`UPDATE budget_transactions SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE budget_allocations SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_assignment_history SET changed_by_user_id = NULL WHERE changed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_assignment_history SET employee_id = NULL WHERE employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_care_level_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_contract_rates SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_contracts SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_documents SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_insurance_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE customer_needs_assessments SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE document_deliveries SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_compensation_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_document_proofs SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_documents SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_month_closings SET reopened_by_user_id = NULL WHERE reopened_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE employee_qualifications SET assigned_by_user_id = NULL WHERE assigned_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE generated_documents SET signed_by_employee_id = NULL WHERE signed_by_employee_id IN (${idList})`);
      await tx.execute(sql`UPDATE generated_documents SET generated_by_user_id = NULL WHERE generated_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE invoices SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE monthly_service_records SET customer_signed_by_user_id = NULL WHERE customer_signed_by_user_id IN (${idList})`);
      await tx.execute(sql`UPDATE monthly_service_records SET employee_signed_by_user_id = NULL WHERE employee_signed_by_user_id IN (${idList})`);

      await tx.execute(sql`DELETE FROM users WHERE id IN (${idList})`);
  });

  return { ok: true, deleted: safeIds, rejected };
}

// Findet alle User, die dem Test-Pattern entsprechen.
export async function findTestUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(USER_TEST_FILTER);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// High-Level-Runner für den periodischen Safety-Scheduler (Task #795)
// ---------------------------------------------------------------------------
export interface TestDataCleanupSummary {
  skipped: boolean;
  reason?: string;
  customersDeleted: number;
  customersFailed: number;
  prospectsDeleted: number;
  usersDeleted: number;
  usersRejected: number;
  usersBlocked: boolean;
}

// Batch-Größe für den User-Purge (mirror't die HTTP-Route purgeUsersSchema.max).
const USER_PURGE_BATCH = 500;

export async function runTestDataCleanup(): Promise<TestDataCleanupSummary> {
  const empty: TestDataCleanupSummary = {
    skipped: true,
    customersDeleted: 0,
    customersFailed: 0,
    prospectsDeleted: 0,
    usersDeleted: 0,
    usersRejected: 0,
    usersBlocked: false,
  };

  if (isProductionEnv()) {
    return { ...empty, reason: "production" };
  }

  // 1) Kunden zuerst (entkoppelt die meisten User-Verflechtungen).
  const custIds = await findTestCustomerIds();
  let customersDeleted = 0;
  let customersFailed = 0;
  if (custIds.length > 0) {
    const res = await purgeTestCustomersByIds(custIds);
    customersDeleted = res.deleted.length;
    customersFailed = res.failed.length;
  }

  // 2) Interessenten (kompletter Backlog-Purge via Test-Pattern).
  const prospectsDeleted = (await purgeTestProspectsByIds()).length;

  // 3) Test-User in Batches.
  const userIds = await findTestUserIds();
  let usersDeleted = 0;
  let usersRejected = 0;
  let usersBlocked = false;
  for (let i = 0; i < userIds.length; i += USER_PURGE_BATCH) {
    const batch = userIds.slice(i, i + USER_PURGE_BATCH);
    const res = await purgeTestUsersByIds(batch);
    if (res.ok) {
      usersDeleted += res.deleted.length;
      usersRejected += res.rejected.length;
    } else {
      usersBlocked = true;
    }
  }

  return {
    skipped: false,
    customersDeleted,
    customersFailed,
    prospectsDeleted,
    usersDeleted,
    usersRejected,
    usersBlocked,
  };
}
