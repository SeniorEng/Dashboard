import { Router, Request, Response } from "express";
import { z } from "zod";
import { inArray, eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { requireSuperAdmin } from "../../middleware/auth";
import { db } from "../../lib/db";
import { customers } from "@shared/schema";
import { appointments, appointmentSeries } from "@shared/schema";
import { invoices, invoiceLineItems } from "@shared/schema";
import { budgetTransactions } from "@shared/schema";
import { prospects } from "@shared/schema";
import { qontoTransactions, paymentAdviceItems } from "@shared/schema";
import { documentDeliveries } from "@shared/schema";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { users } from "@shared/schema/users";
import { services } from "@shared/schema";
import { appointmentServices } from "@shared/schema";
import { customerServicePrices } from "@shared/schema";

const router = Router();

const purgeSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(2000),
});

async function purgeCustomerCascade(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(prospects)
      .set({ convertedCustomerId: null })
      .where(eq(prospects.convertedCustomerId, id));

    await tx.update(customers)
      .set({ mergedIntoCustomerId: null })
      .where(eq(customers.mergedIntoCustomerId, id));

    const apptIdsRows = await tx
      .select({ id: appointments.id })
      .from(appointments)
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

router.post(
  "/test-cleanup/purge-customers",
  requireSuperAdmin,
  asyncHandler("Test-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    const { ids } = purgeSchema.parse(req.body);
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
    res.json({ deleted, failed });
  })
);

const purgeCalendarRangeSchema = z.object({
  startOffsetDays: z.number().int().min(1).max(2000),
  endOffsetDays: z.number().int().min(1).max(2000),
}).refine((d) => d.endOffsetDays >= d.startOffsetDays, {
  message: "endOffsetDays muss >= startOffsetDays sein",
});

function offsetToDateString(offsetDays: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

router.post(
  "/test-cleanup/purge-admin-calendar-range",
  requireSuperAdmin,
  asyncHandler("Kalender-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    const { startOffsetDays, endOffsetDays } = purgeCalendarRangeSchema.parse(req.body);
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const startDate = offsetToDateString(startOffsetDays);
    const endDate = offsetToDateString(endOffsetDays);

    let timeEntriesDeleted = 0;
    let appointmentsDeleted = 0;

    await db.transaction(async (tx) => {
      const teResult = await tx
        .update(employeeTimeEntries)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(employeeTimeEntries.userId, userId),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt),
        ))
        .returning({ id: employeeTimeEntries.id });
      timeEntriesDeleted = teResult.length;

      const apptIdsRows = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(
          eq(appointments.assignedEmployeeId, userId),
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
        ));
      const apptIds = apptIdsRows.map(r => r.id);

      if (apptIds.length > 0) {
        await tx.update(budgetTransactions)
          .set({ appointmentId: null })
          .where(inArray(budgetTransactions.appointmentId, apptIds));
        await tx.update(appointments)
          .set({ travelFromAppointmentId: null })
          .where(inArray(appointments.travelFromAppointmentId, apptIds));
        const apptResult = await tx
          .update(appointments)
          .set({ deletedAt: new Date() })
          .where(inArray(appointments.id, apptIds))
          .returning({ id: appointments.id });
        appointmentsDeleted = apptResult.length;
      }
    });

    res.json({
      userId,
      startDate,
      endDate,
      timeEntriesDeleted,
      appointmentsDeleted,
    });
  })
);

// ---------------------------------------------------------------------------
// Test-User-Cleanup: löscht hart, inkl. audit_log-Einträge der Test-User.
// Audit-Log ist per RULE append-only — wir umgehen das nur für die Dauer der
// Transaktion (im finally wieder eingeschaltet, auch bei Fehlern).
// ---------------------------------------------------------------------------
const purgeUsersSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
});

router.post(
  "/test-cleanup/purge-test-users",
  requireSuperAdmin,
  asyncHandler("Test-User-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    const { ids } = purgeUsersSchema.parse(req.body);

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
      res.json({ deleted: [], rejected, reason: "Keine IDs entsprechen dem Test-User-Muster." });
      return;
    }

    const idList = sql.join(safeIds.map((i) => sql`${i}`), sql`, `);

    // Pre-Flight-Sicherheitscheck (gespiegelt aus cleanup-test-data.ts):
    // Test-User dürfen NICHT mit echten Kunden verflochten sein, sonst würden
    // wir bei Hard-Delete von monthly_service_records / customer_assignment_history
    // / aktiven Terminen Daten echter Kunden zerstören.
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
      res.status(409).json({
        error: "BLOCKED_REAL_CUSTOMER_REFS",
        message: `Test-User sind mit echten Kunden verflochten (${b.appt} aktive Termine, ${b.msr} Monats-LN, ${b.cah} Zuweisungen). Cleanup verweigert, um Datenverlust zu verhindern.`,
        rejected: ids,
      });
      return;
    }

    // Audit-Schutzregeln nur für die Dauer dieses Batches deaktivieren.
    // ENABLE RULE auf bereits aktivierte Regel ist ein No-op, daher in finally
    // immer beide ausführen — selbst wenn DISABLE für die zweite fehlschlug,
    // wird die erste sicher wieder aktiviert.
    let disabledNoDelete = false;
    let disabledNoUpdate = false;
    try {
      await db.execute(sql`ALTER TABLE audit_log DISABLE RULE audit_log_no_delete`);
      disabledNoDelete = true;
      await db.execute(sql`ALTER TABLE audit_log DISABLE RULE audit_log_no_update`);
      disabledNoUpdate = true;

      await db.transaction(async (tx) => {
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
        // Serien echter Kunden treffen, denen mal ein Test-Mitarbeiter zugewiesen
        // war. Series der Test-Kunden sind bereits über purge-customers weg;
        // verbleibende Series gehören echten Kunden und bekommen unten SET NULL.
        await tx.execute(sql`DELETE FROM employee_compensation_history WHERE created_by_user_id IN (${idList})`);

        // SET NULL on nullable FK refs (NO ACTION rules) — Test-User-Spuren
        // in System-/Echt-Daten nullen, damit echte Daten unangetastet bleiben
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
        await tx.execute(sql`UPDATE customer_budgets SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_care_level_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_contract_rates SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_contracts SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_documents SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_insurance_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_needs_assessments SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
        await tx.execute(sql`UPDATE customer_pricing_history SET created_by_user_id = NULL WHERE created_by_user_id IN (${idList})`);
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
    } finally {
      // Audit-Schutzregeln in jedem Fall wieder aktivieren — ENABLE auf
      // bereits aktivierter Regel ist ein No-op, also safe.
      if (disabledNoUpdate) {
        try { await db.execute(sql`ALTER TABLE audit_log ENABLE RULE audit_log_no_update`); } catch {}
      }
      if (disabledNoDelete) {
        try { await db.execute(sql`ALTER TABLE audit_log ENABLE RULE audit_log_no_delete`); } catch {}
      }
    }

    res.json({ deleted: safeIds, rejected });
  })
);

// ---------------------------------------------------------------------------
// Test-Service-Cleanup: löscht nur Services, die in keinem Termin mehr
// referenziert werden (Preis-Overrides werden via CASCADE entfernt).
// ---------------------------------------------------------------------------
const purgeServicesSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
});

router.post(
  "/test-cleanup/purge-test-services",
  requireSuperAdmin,
  asyncHandler("Test-Service-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    const { ids } = purgeServicesSchema.parse(req.body);

    // Nur Services mit Test-Pattern berücksichtigen.
    const testServices = await db
      .select({ id: services.id })
      .from(services)
      .where(and(
        inArray(services.id, ids),
        // Eng gefasst (Task #183 Spec): nur unverkennbare Test-Marker im Namen
        // ODER Code. NICHT generisches "test" Substring, sonst würden Produktiv-
        // Services mit "test" im Namen versehentlich gelöscht.
        sql`(LOWER(${services.name}) LIKE '%#_test#_%' ESCAPE '#' OR LOWER(${services.code}) LIKE 'qs-test-%')`,
      ));
    const candidateIds = testServices.map((s) => s.id);
    if (candidateIds.length === 0) {
      res.json({ deleted: [], skippedReferenced: [], rejected: ids });
      return;
    }

    // Filter: nicht in appointment_services referenziert
    const refs = await db
      .selectDistinct({ id: appointmentServices.serviceId })
      .from(appointmentServices)
      .where(inArray(appointmentServices.serviceId, candidateIds));
    const referenced = new Set(refs.map((r) => r.id).filter((id): id is number => id !== null));
    const deletable = candidateIds.filter((i) => !referenced.has(i));

    if (deletable.length > 0) {
      await db.delete(services).where(inArray(services.id, deletable));
    }

    res.json({
      deleted: deletable,
      skippedReferenced: candidateIds.filter((i) => referenced.has(i)),
      rejected: ids.filter((i) => !candidateIds.includes(i)),
    });
  })
);

// ---------------------------------------------------------------------------
// Test-Helfer: Roher Insert in customer_service_prices, ohne Dedup-/Soft-Delete-
// Logik der regulären POST /api/customers/:id/service-prices Route.
// Ausschließlich für Boundary-Tests gedacht (Race-Condition / manuelles Insert
// gleicher validFrom). In Produktion deaktiviert.
// ---------------------------------------------------------------------------
const insertCustomerPriceRawSchema = z.object({
  customerId: z.number().int().positive(),
  serviceId: z.number().int().positive(),
  priceCents: z.number().int().min(1),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

router.post(
  "/test-cleanup/insert-customer-service-price-raw",
  requireSuperAdmin,
  asyncHandler("Roh-Insert Kundenpreis fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Helfer ist in Produktion deaktiviert" });
      return;
    }
    const parsed = insertCustomerPriceRawSchema.parse(req.body);
    const inserted = await db.insert(customerServicePrices).values({
      customerId: parsed.customerId,
      serviceId: parsed.serviceId,
      priceCents: parsed.priceCents,
      validFrom: new Date(parsed.validFrom + "T00:00:00Z"),
      validTo: parsed.validTo ? new Date(parsed.validTo + "T00:00:00Z") : null,
    }).returning({
      id: customerServicePrices.id,
      customerId: customerServicePrices.customerId,
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
    });
    res.json(inserted[0]);
  })
);

export default router;
