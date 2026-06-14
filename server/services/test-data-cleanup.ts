// ---------------------------------------------------------------------------
// Test-Data-Cleanup-Service (Task #795)
//
// Zentrale, wiederverwendbare Implementierung der gescopten Test-Daten-Purges.
// Sie ist die Single Source of Truth für die HTTP-Routen in
// `server/routes/admin/test-cleanup.ts`.
//
// Task #894: Seit jeder Integrationslauf seine eigene wegwerf-DB nutzt
// (`scripts/with-ephemeral-db.ts`), wächst kein Stale-Pool mehr an. Der frühere
// periodische Safety-Scheduler und der `globalSetup`-Bulk-Purge wurden deshalb
// entfernt. Service + Routen bleiben als gescopte, getestete Utility erhalten
// (z.B. für manuelle Aufräum-Aktionen auf einer geteilten Dev-DB).
//
// SICHERHEIT: Alle Funktionen sind in Production ein No-op (siehe
// `assertNotProduction`). Die SQL-Test-Pattern-Filter spiegeln die
// `isTest*`-Heuristiken aus `tests/globalSetup.ts`, sodass NIEMALS echte
// Kunden/Interessenten/User getroffen werden können.
// ---------------------------------------------------------------------------
import { inArray, eq, and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "../lib/db";
import { appointmentsRepo, prospectsRepo, customersRepo, customerServicePricesRepo } from "../repos";
import { customers } from "@shared/schema";
import { appointments, appointmentSeries, appointmentServices } from "@shared/schema";
import { invoices, invoiceLineItems } from "@shared/schema";
import { budgetTransactions } from "@shared/schema";
import { prospects } from "@shared/schema";
import { qontoTransactions, paymentAdviceItems } from "@shared/schema";
import { documentDeliveries } from "@shared/schema";
import { services, customerServicePrices } from "@shared/schema";
import {
  documentTypes,
  employeeDocuments,
  customerDocuments,
  generatedDocuments,
} from "@shared/schema";
import { qualificationDocuments, employeeDocumentProofs } from "@shared/schema/qualifications";
import { users } from "@shared/schema/users";

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// SQL-Test-Pattern-Filter — gespiegelt aus tests/globalSetup.ts (isTest*).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SSoT — Test-Kunden-Namens-Präfixe der Isolations-/Equality-Suiten (Task #1265)
//
// Die Isolations-Suiten legen Kunden mit festen vorname-Präfixen an
// (`T723-…`, `T642…`, `ZZ-E2E-…`). Diese eine Präfix-Liste ist die EINZIGE
// Quelle, aus der ALLE drei gespiegelten Kunden-Filter ihr Match-Fragment
// ableiten (Drizzle `CUSTOMER_TEST_FILTER` hier + Roh-SQL
// `CUSTOMER_TEST_CONDITION` und der `c.`-aliasierte `CUSTOMER_TEST_C` in
// `server/scripts/cleanup-test-data.ts`) — ebenso der Wächter
// `scripts/check-no-test-junk.ts`. Neue Isolations-Präfixe NUR hier ergänzen
// (Ersetzungs-Regel: ersetzt verstreute Pattern-Kopien durch eine Quelle).
//
// Ausnahme: dokumentierte Hand-Test-Kunden mit vorname-Präfix „ZZ-Test" bleiben
// IMMER erhalten. Der Ausschluss umklammert den GESAMTEN Filter, weil bereits
// das bestehende `%test%` ein „ZZ-Test" fängt.
export const CUSTOMER_ISOLATION_TEST_PREFIXES = ["t723-", "t642", "zz-e2e-"] as const;
export const CUSTOMER_PRESERVE_VORNAME_PREFIX = "zz-test";

// „vorname matcht eines der Isolations-Präfixe" — für eine beliebige
// vorname-Spalten-SQL (Drizzle-Spaltenref ODER sql.raw("vorname")/("c.vorname")).
export function customerIsolationMatchSql(vornameExpr: SQL | SQLWrapper): SQL {
  const ors = CUSTOMER_ISOLATION_TEST_PREFIXES.map(
    (p) => sql`LOWER(${vornameExpr}) LIKE ${p + "%"}`,
  );
  return sql`(${sql.join(ors, sql` OR `)})`;
}

// „vorname gehört zu einem erhaltenen ZZ-Test-Kunden" (Ausschluss-Prädikat).
export function customerPreserveSql(vornameExpr: SQL | SQLWrapper): SQL {
  return sql`LOWER(${vornameExpr}) LIKE ${CUSTOMER_PRESERVE_VORNAME_PREFIX + "%"}`;
}

// Mirror von isTestCustomer(). Unterstriche in LIKE müssen via ESCAPE neutralisiert
// werden (auto_ → 'auto#_%'). Der Isolations-Präfix-Match (Task #1265) hängt an
// derselben OR-Kette; die ZZ-Test-Ausnahme umklammert den GESAMTEN Filter.
export const CUSTOMER_TEST_FILTER = sql`(
  (
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
    OR ${customerIsolationMatchSql(customers.vorname)}
  )
  AND NOT ${customerPreserveSql(customers.vorname)}
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
    // Task #828: Der Kunden-Purge löscht Rechnungen/Positionen und triggert
    // per Customer-Cascade auch budget_allocations/customer_budget_type_settings
    // (GoBD-Hard-Delete-Trigger). Bypass transaktions-lokal freischalten.
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
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
      // FK budget_transactions.appointment_id → appointments lösen, bevor die
      // Termine hart gelöscht werden. NICHT auf NULL setzen: der CHECK
      // `budget_transactions_appointment_required_check` verlangt für
      // consumption-/reversal-Zeilen ein gesetztes appointment_id. Diese Zeilen
      // gehören demselben Kunden und werden ohnehin gleich gelöscht — daher
      // direkt entfernen statt detachen.
      await tx.delete(budgetTransactions)
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

// ---------------------------------------------------------------------------
// Set-based Bulk-Kunden-Purge (Task #887)
//
// `purgeCustomerCascade` lief bisher in EINER Transaktion PRO Kunde. Bei einem
// gewachsenen Stale-Backlog (dutzende+ Test-Kunden) summierte sich das zu
// hunderten seriellen Transaktionen und ließ `tests/globalSetup.ts` so lange im
// Cleanup hängen, dass der Run abgebrochen wurde, BEVOR der erste Test lief.
//
// `purgeCustomerCascadeBulk` macht denselben Cascade für eine MENGE von IDs in
// EINER Transaktion (inArray statt eq) — O(1) Transaktionen pro Batch statt
// O(n). Die FK-Detach-/Delete-Reihenfolge ist identisch zur Einzelvariante.
// ---------------------------------------------------------------------------
export async function purgeCustomerCascadeBulk(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    // Task #828: Customer-Cascade triggert GoBD-Hard-Delete-Trigger
    // (budget_allocations/customer_budget_type_settings/invoices). Bypass
    // transaktions-lokal freischalten.
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);

    await tx.update(prospects)
      .set({ convertedCustomerId: null })
      .where(inArray(prospects.convertedCustomerId, ids));

    await tx.update(customers)
      .set({ mergedIntoCustomerId: null })
      .where(inArray(customers.mergedIntoCustomerId, ids));

    // Hard-delete unten entfernt ALLE (auch soft-gelöschte) Termine/Rechnungen
    // dieser Kunden — FK-Refs daher ohne activeOnly() auflösen.
    const apptIdsRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id }, tx)
      .where(inArray(appointments.customerId, ids));
    const apptIds = apptIdsRows.map((r) => r.id);

    const invIdsRows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(inArray(invoices.customerId, ids));
    const invIds = invIdsRows.map((r) => r.id);

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
      await tx.delete(invoices).where(inArray(invoices.customerId, ids));
    }

    await tx.delete(appointmentSeries).where(inArray(appointmentSeries.customerId, ids));

    if (apptIds.length > 0) {
      // FK budget_transactions.appointment_id → appointments lösen, bevor die
      // Termine hart gelöscht werden. NICHT auf NULL setzen: der CHECK
      // `budget_transactions_appointment_required_check` verlangt für
      // consumption-/reversal-Zeilen ein gesetztes appointment_id. Diese Zeilen
      // gehören den zu löschenden Kunden und werden ohnehin gleich gelöscht —
      // daher direkt entfernen statt detachen.
      await tx.delete(budgetTransactions)
        .where(inArray(budgetTransactions.appointmentId, apptIds));
      await tx.update(appointments)
        .set({ travelFromAppointmentId: null })
        .where(inArray(appointments.travelFromAppointmentId, apptIds));
      await tx.delete(appointments).where(inArray(appointments.customerId, ids));
    }

    await tx.delete(documentDeliveries).where(inArray(documentDeliveries.customerId, ids));
    await tx.delete(budgetTransactions).where(inArray(budgetTransactions.customerId, ids));

    await tx.delete(customers).where(inArray(customers.id, ids));
  });
}

// Batch-Größe für den Bulk-Kunden-Purge. Klein genug, damit eine einzelne
// Transaktion keine riesigen IN-Listen erzeugt, groß genug, um die Zahl der
// Transaktionen drastisch gegenüber dem alten O(n)-Pro-Kunde-Loop zu senken.
const CUSTOMER_PURGE_BATCH = 200;

// Bulk-Purge der übergebenen Kunden-IDs, set-based in Batches. Schlägt ein
// ganzer Batch fehl (z.B. unerwarteter neuer FK-Weg), fällt NUR dieser Batch auf
// den per-Record-Cascade zurück, damit ein einzelner „poison row" nicht den
// gesamten Backlog blockiert.
//
// BEWUSST OHNE Test-Pattern-Filter auf den übergebenen IDs: die
// `purge-customers`-Route ist (anders als prospects/users) absichtlich
// ungefiltert per-ID — Tests legen Kunden mit beliebigen (auch nicht-Test-
// Pattern) Namen an und räumen sie über diese Route per ID wieder auf
// (siehe tests/test-cleanup-safety.test.ts CLEAN-1.3). Das Test-Pattern-Scoping
// für den Full-Backlog-Purge passiert stattdessen bei der ID-Ermittlung über
// `findTestCustomerIds()` (CUSTOMER_TEST_FILTER).
export async function purgeTestCustomersBulk(ids: number[]): Promise<PurgeCustomersResult> {
  if (ids.length === 0) return { deleted: [], failed: [] };

  const deleted: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  for (let i = 0; i < ids.length; i += CUSTOMER_PURGE_BATCH) {
    const batch = ids.slice(i, i + CUSTOMER_PURGE_BATCH);
    try {
      await purgeCustomerCascadeBulk(batch);
      deleted.push(...batch);
    } catch {
      // Per-Record-Fallback nur für diesen Batch.
      const res = await purgeTestCustomersByIds(batch);
      deleted.push(...res.deleted);
      failed.push(...res.failed);
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
    // Task #828: Das Lösen der Termin-Refs setzt invoice_line_items.appointment_id
    // auf NULL — bei Positionen finalisierter Rechnungen greift sonst der
    // GoBD-Trigger. Bypass transaktions-lokal freischalten (Test-Pfad).
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
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
      // Task #1273: budget_transactions ist seit Stufe B GoBD-immutable
      // (BEFORE-Trigger) — wie budget_allocations/invoices unten löst dieser
      // User-Cleanup created_by_user_id/appointment_id-Refs. Bypass
      // transaktions-lokal freischalten.
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      // Task #906: Ziel-User VOR jedem Child-Delete mit FOR UPDATE sperren.
      // Unter paralleler Test-Last (Task #894) legt der live laufende
      // Worker-App-Server u.U. zwischen Child-Delete und `DELETE FROM users`
      // eine neue `notifications`-Zeile für den Test-User an — ein FK-Insert
      // nimmt dabei einen FOR-KEY-SHARE-Lock auf die Parent-Row. Halten WIR
      // bereits einen FOR-UPDATE-Lock auf dieselbe Row, blockiert dieser
      // Insert bis zu unserem Commit (dann ist der User weg) — der spätere
      // `DELETE FROM users` kann also nicht mehr an einer nebenläufig neu
      // entstandenen Child-Row scheitern.
      await tx.execute(sql`SELECT id FROM users WHERE id IN (${idList}) FOR UPDATE`);
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

export interface PurgeAllUsersResult {
  deleted: number[];
  rejected: number[];
  blocked: boolean;
}

// Full-Backlog-Purge aller Test-Pattern-User in Batches (Task #887). Wird vom
// `purge-test-users`-Endpoint (ohne explizite ids) und von `globalSetup`
// genutzt, damit der User-Cleanup nicht mehr von einer client-seitigen
// Fetch-Obergrenze (limit=1000) gedeckelt ist.
export async function purgeAllTestUsers(): Promise<PurgeAllUsersResult> {
  const ids = await findTestUserIds();
  const deleted: number[] = [];
  const rejected: number[] = [];
  let blocked = false;
  for (let i = 0; i < ids.length; i += USER_PURGE_BATCH) {
    const batch = ids.slice(i, i + USER_PURGE_BATCH);
    const res = await purgeTestUsersByIds(batch);
    if (res.ok) {
      deleted.push(...res.deleted);
      rejected.push(...res.rejected);
    } else {
      blocked = true;
    }
  }
  return { deleted, rejected, blocked };
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
    // Task #887: set-based Bulk-Purge statt eines per-Record-Transaktions-Loops.
    const res = await purgeTestCustomersBulk(custIds);
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

// ---------------------------------------------------------------------------
// Test-Service-Purge (Task #1173)
//
// Räumt Test-„Müll"-Services aus den Dev-Tabellen, die historische Testläufe
// hinterlassen haben (Team-Lead-Tests `tlsicht_*`/`tlwrite_*`, ältere
// `*_test_*` / `qs-test-*`-Marker). Strategie nach Vorgabe:
//   - Services OHNE Termin-/Preis-Referenz werden HART gelöscht (service_budget_pots
//     hängen per ON DELETE CASCADE dran und fallen mit).
//   - Services MIT Termin- (`appointment_services`, FK = NO ACTION) ODER Preis-
//     Referenz (`customer_service_prices`, FK = CASCADE) werden NUR soft-
//     deaktiviert (`is_active = false`), damit keine FK-Brüche entstehen und
//     historische Preisvereinbarungen erhalten bleiben.
//
// ids optional: ohne ids wird der KOMPLETTE Test-Service-Backlog (Pattern)
// verarbeitet; mit ids wird zusätzlich auf diese gescopt. Der Pattern-Filter
// ist die Sicherheits-Schranke — Produktiv-Services mit „test" im Freitext
// werden NICHT getroffen.
// ---------------------------------------------------------------------------

// Unverkennbare Test-Marker in Name ODER Code. Unterstriche via ESCAPE '#'
// neutralisiert, damit sie literal matchen (nicht als LIKE-Wildcard).
export const SERVICE_TEST_FILTER = sql`(
  LOWER(${services.name}) LIKE '%#_test#_%' ESCAPE '#'
  OR LOWER(${services.code}) LIKE 'qs-test-%'
  OR LOWER(${services.name}) LIKE 'tlsicht#_%' ESCAPE '#'
  OR LOWER(${services.name}) LIKE 'tlwrite#_%' ESCAPE '#'
  OR LOWER(${services.code}) LIKE 'tlsicht#_%' ESCAPE '#'
  OR LOWER(${services.code}) LIKE 'tlwrite#_%' ESCAPE '#'
)`;

export interface PurgeServicesResult {
  deleted: number[];
  deactivated: number[];
  rejected: number[];
}

export async function purgeTestServices(ids?: number[]): Promise<PurgeServicesResult> {
  const where = ids && ids.length > 0
    ? and(inArray(services.id, ids), SERVICE_TEST_FILTER)
    : SERVICE_TEST_FILTER;

  const candidates = await db.select({ id: services.id }).from(services).where(where);
  const candidateIds = candidates.map((s) => s.id);
  const rejected = ids ? ids.filter((i) => !candidateIds.includes(i)) : [];
  if (candidateIds.length === 0) {
    return { deleted: [], deactivated: [], rejected };
  }

  const apptRefs = await db
    .selectDistinct({ id: appointmentServices.serviceId })
    .from(appointmentServices)
    .where(inArray(appointmentServices.serviceId, candidateIds));
  // selectColumnsFrom OHNE activeOnly() → bewusst inkl. soft-gelöschter Preis-
  // Zeilen, denn auch eine soft-gelöschte Zeile hält physisch den FK auf den
  // Service und würde ein hartes DELETE brechen.
  const priceRefs = await customerServicePricesRepo
    .selectColumnsFrom({ id: customerServicePrices.serviceId })
    .where(inArray(customerServicePrices.serviceId, candidateIds));
  const referenced = new Set<number>(
    [...apptRefs.map((r) => r.id), ...priceRefs.map((r) => r.id)].filter(
      (i): i is number => i !== null,
    ),
  );

  const deletable = candidateIds.filter((i) => !referenced.has(i));
  const toDeactivate = candidateIds.filter((i) => referenced.has(i));

  await db.transaction(async (tx) => {
    if (deletable.length > 0) {
      // service_budget_pots = ON DELETE CASCADE. customer_service_prices der
      // deletable-Services existieren per Definition nicht (sonst referenced).
      await tx.delete(services).where(inArray(services.id, deletable));
    }
    if (toDeactivate.length > 0) {
      await tx
        .update(services)
        .set({ isActive: false })
        .where(inArray(services.id, toDeactivate));
    }
  });

  return { deleted: deletable, deactivated: toDeactivate, rejected };
}

// ---------------------------------------------------------------------------
// Test-Dokumenttyp-Purge (Task #1173)
//
// Entfernt Test-„Müll"-Dokumenttypen (`DOC%_17777%`), die historische Testläufe
// als Pflichtdokumenttypen angelegt haben und die in Schritt 7 der Kundenanlage
// auftauchen. Strategie analog zu den Services:
//   - Dokumenttypen OHNE echte Dokument-Referenz werden HART gelöscht
//     (`document_type_triggers`/`document_templates`/`generated_documents` hängen
//     per CASCADE bzw. SET NULL dran und werden sauber mitgeräumt).
//   - Dokumenttypen MIT echter Dokument-Referenz (hochgeladene/erzeugte/Nachweis-
//     Dokumente) werden NUR soft-deaktiviert (`is_active = false`), damit keine
//     realen Dokumente per CASCADE verloren gehen.
// ---------------------------------------------------------------------------

// BUG-18 (Task #1230): WHITELIST-Ansatz statt Namens-Pattern-Blacklist.
//
// Historische Testläufe haben generierte „Müll"-Dokumenttypen mit DOC-Prefix
// (`DOC<n>_<epoch-ms>_<rand>`, z.B. `DOC6_1777740879740_o27v3`) als
// Pflichtdokumenttypen angelegt. Eine nachzuschärfende Namens-Blacklist
// (früher `DOC%_17777%`, dann `^DOC[0-9]+_[0-9]+_`) ließ immer wieder Müll
// durchrutschen. Stattdessen fixieren wir die ECHTEN Dokumenttypen als
// Whitelist (SSoT, aus Dev abgeleitet, mit Alrik abzugleichen): Test-Müll ist
// JEDER Dokumenttyp mit DOC-Prefix, der NICHT in der Whitelist steht.
//
// Echte Typen beginnen NIE mit „DOC"; die `NOT IN`-Whitelist ist daher
// zusätzlicher Gürtel-und-Hosenträger-Schutz, falls je ein echter Typ mit
// DOC-Prefix angelegt würde. Bewusst case-sensitiv (Müll ist immer `DOC...`).
//
// SSoT: Whitelist + Prefix + reine Klassifikation werden exportiert, damit der
// Nachhaltigkeits-Guard (`scripts/check-no-test-junk.ts`), das CLI-Skript
// (`server/scripts/cleanup-test-data.ts`), das Prod-Migrations-Skript
// (`server/startup/purge-junk-master-data.ts`) und der Unit-Test EXAKT dieselbe
// Klassifikation nutzen. SQL-`LIKE 'DOC%'` (case-sensitiv) ≡ JS-`startsWith`.
export const DOCUMENT_TYPE_WHITELIST: readonly string[] = [
  "Führerschein",
  "Arbeitsvertrag",
  "Arbeitsunterweisung",
  "Kundenvertrag",
  "Forderungsabtretung",
  "Datenschutzerklärung",
  "Erste Hilfe Zertifikat",
  "Führungszeugnis - einfach",
  "Führungszeugnis - erweitert",
  "Personenbeförderungsschein",
  "Schlüsselübergabeprotokoll",
  "Vollmacht",
  "Einwilligungserklärung",
  "Sonstiges Dokument",
  "Ärztliche Verordnung",
  "Pflegegradbescheid",
  "Betreuungsvertrag (Pflegekasse)",
  "Dienstleistungsvertrag (Selbstzahler)",
  "Datenschutzvereinbarung",
  "SEPA-Lastschriftmandat",
  "Abtretungserklärung",
  "Auskunftsvollmacht zur Budgetabfrage (SGB XI)",
] as const;

// Case-sensitiver Müll-Marker-Prefix.
export const DOCUMENT_TYPE_JUNK_PREFIX = "DOC";

const DOCUMENT_TYPE_WHITELIST_SET = new Set<string>(DOCUMENT_TYPE_WHITELIST);

// Reine Klassifikation (für Guard/Unit-Test ohne DB): DOC-Prefix UND nicht
// gewhitelistet. Zeichengleich zum SQL-Filter darunter.
export function isDocumentTypeTestJunk(name: string): boolean {
  return name.startsWith(DOCUMENT_TYPE_JUNK_PREFIX) && !DOCUMENT_TYPE_WHITELIST_SET.has(name);
}

export const DOCUMENT_TYPE_TEST_FILTER = sql`(
  ${documentTypes.name} LIKE 'DOC%'
  AND ${documentTypes.name} NOT IN (${sql.join(
    DOCUMENT_TYPE_WHITELIST.map((n) => sql`${n}`),
    sql`, `,
  )})
)`;

export interface PurgeDocumentTypesResult {
  deleted: number[];
  deactivated: number[];
  rejected: number[];
}

export async function purgeTestDocumentTypes(ids?: number[]): Promise<PurgeDocumentTypesResult> {
  const where = ids && ids.length > 0
    ? and(inArray(documentTypes.id, ids), DOCUMENT_TYPE_TEST_FILTER)
    : DOCUMENT_TYPE_TEST_FILTER;

  const candidates = await db.select({ id: documentTypes.id }).from(documentTypes).where(where);
  const candidateIds = candidates.map((d) => d.id);
  const rejected = ids ? ids.filter((i) => !candidateIds.includes(i)) : [];
  if (candidateIds.length === 0) {
    return { deleted: [], deactivated: [], rejected };
  }

  // Echte Dokument-Referenzen (alle CASCADE/SET-NULL-Tabellen, die NUTZER-Daten
  // tragen — Trigger/Templates sind reine Konfiguration und werden beim Löschen
  // ohnehin mitgeräumt, zählen daher NICHT als „referenziert").
  const referenced = new Set<number>();
  const refTables = [
    { col: employeeDocuments.documentTypeId, table: employeeDocuments },
    { col: customerDocuments.documentTypeId, table: customerDocuments },
    { col: generatedDocuments.documentTypeId, table: generatedDocuments },
    { col: qualificationDocuments.documentTypeId, table: qualificationDocuments },
    { col: employeeDocumentProofs.documentTypeId, table: employeeDocumentProofs },
  ] as const;
  for (const { col, table } of refTables) {
    const rows = await db
      .selectDistinct({ id: col })
      .from(table)
      .where(inArray(col, candidateIds));
    for (const r of rows) {
      if (r.id !== null) referenced.add(r.id);
    }
  }

  const deletable = candidateIds.filter((i) => !referenced.has(i));
  const toDeactivate = candidateIds.filter((i) => referenced.has(i));

  await db.transaction(async (tx) => {
    if (deletable.length > 0) {
      // document_type_triggers = CASCADE, document_templates/generated_documents
      // = SET NULL — keine FK-Brüche.
      await tx.delete(documentTypes).where(inArray(documentTypes.id, deletable));
    }
    if (toDeactivate.length > 0) {
      await tx
        .update(documentTypes)
        .set({ isActive: false })
        .where(inArray(documentTypes.id, toDeactivate));
    }
  });

  return { deleted: deletable, deactivated: toDeactivate, rejected };
}
