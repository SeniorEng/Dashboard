import { Router, Request, Response } from "express";
import { z } from "zod";
import { inArray, eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/errors";
import { requireSuperAdmin } from "../../middleware/auth";
import { db } from "../../lib/db";
import { appointmentsRepo } from "../../repos";
import { customers } from "@shared/schema";
import { appointments } from "@shared/schema";
import { budgetTransactions } from "@shared/schema";
import { employeeTimeEntries } from "@shared/schema/time-tracking";
import { services } from "@shared/schema";
import { appointmentServices } from "@shared/schema";
import { customerServicePrices } from "@shared/schema";
import {
  purgeTestCustomersBulk,
  purgeTestProspectsByIds,
  purgeTestUsersByIds,
  purgeAllTestUsers,
  findTestCustomerIds,
} from "../../services/test-data-cleanup";

const router = Router();

const backdateSchema = z.object({
  customerId: z.number().int().positive(),
  createdAt: z.string().min(8),
});

router.post(
  "/test-cleanup/backdate-customer-created-at",
  requireSuperAdmin,
  asyncHandler("Backdate fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    const { customerId, createdAt } = backdateSchema.parse(req.body);
    const parsed = new Date(createdAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "INVALID_DATE", message: "createdAt ist kein gültiges Datum" });
      return;
    }
    await db.update(customers).set({ createdAt: parsed }).where(eq(customers.id, customerId));
    res.json({ ok: true });
  }),
);

router.post(
  "/test-cleanup/purge-customers",
  requireSuperAdmin,
  asyncHandler("Test-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    // Task #887: ids optional. Ohne ids wird der KOMPLETTE Test-Kunden-Backlog
    // gescopt gepurged (One-Time-Backlog-Purge); mit ids wird zusätzlich darauf
    // gescopt. Gelöscht wird in jedem Fall set-based in Batches.
    const { ids } = z.object({
      ids: z.array(z.number().int().positive()).max(20000).optional(),
    }).parse(req.body ?? {});
    const targetIds = ids && ids.length > 0 ? ids : await findTestCustomerIds();
    const { deleted, failed } = await purgeTestCustomersBulk(targetIds);
    res.json({ deleted, failed });
  })
);

// ---------------------------------------------------------------------------
// Test-Prospect-Cleanup (Task #789): löscht stale Test-Interessenten in EINEM
// gescopten Query statt per HTTP-DELETE pro Datensatz. Es gab nie eine
// DELETE /api/prospects/:id-Route — der alte globalSetup-Loop lief deshalb in
// 404s pro Datensatz und fraß bei 3000+ stale Prospects das gesamte Test-
// Zeitbudget. Die eigentliche Lösch-Logik (inkl. Test-Pattern-Filter) lebt im
// wiederverwendbaren Service `server/services/test-data-cleanup.ts`, sodass der
// periodische Safety-Scheduler (Task #795) dieselbe gescopte Logik nutzt.
// ---------------------------------------------------------------------------
router.post(
  "/test-cleanup/purge-prospects",
  requireSuperAdmin,
  asyncHandler("Test-Prospect-Cleanup fehlgeschlagen", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "FORBIDDEN", message: "Test-Cleanup ist in Produktion deaktiviert" });
      return;
    }
    // ids ist optional: ohne ids werden ALLE Test-Interessenten gelöscht
    // (One-Time-Backlog-Purge). Mit ids wird zusätzlich auf diese IDs gescopt.
    const { ids } = z.object({
      ids: z.array(z.number().int().positive()).max(10000).optional(),
    }).parse(req.body ?? {});

    const deleted = await purgeTestProspectsByIds(ids);
    res.json({ deleted });
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

      const apptIdsRows = await appointmentsRepo.selectColumnsFrom({ id: appointments.id }, tx)
        .where(and(
          eq(appointments.assignedEmployeeId, userId),
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          appointmentsRepo.activeOnly(),
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
// Die eigentliche Lösch-Logik (Detach-Pass, Blocker, Audit-Rule-Toggle) lebt im
// wiederverwendbaren Service `server/services/test-data-cleanup.ts`, sodass der
// periodische Safety-Scheduler (Task #795) dieselbe gescopte Logik nutzt.
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
    // Task #887: ids optional. Ohne ids wird der KOMPLETTE Test-User-Backlog
    // gescopt in Batches gepurged (One-Time-Backlog-Purge), unabhängig von einer
    // client-seitigen Fetch-Obergrenze.
    const body = (req.body ?? {}) as { ids?: unknown };
    if (body.ids === undefined || body.ids === null) {
      const all = await purgeAllTestUsers();
      res.json({ deleted: all.deleted, rejected: all.rejected, blocked: all.blocked });
      return;
    }

    const { ids } = purgeUsersSchema.parse(body);
    const result = await purgeTestUsersByIds(ids);

    if (!result.ok) {
      // Sollte nach dem Detach-Pass nie eintreten — Sicherheitsnetz für
      // unerwartete neue FK-Wege (z.B. neue Spalten künftiger Migrationen).
      res.status(409).json({
        error: "BLOCKED_REAL_CUSTOMER_REFS",
        message: `Test-User sind weiter mit echten Kunden verflochten (${result.counts.appt} aktive Termine, ${result.counts.msr} Monats-LN, ${result.counts.cah} Zuweisungen) trotz Detach-Pass. Cleanup verweigert, um Datenverlust zu verhindern.`,
        rejected: result.rejected,
        detached: result.detached,
      });
      return;
    }

    if (result.reason) {
      res.json({ deleted: result.deleted, rejected: result.rejected, reason: result.reason });
      return;
    }
    res.json({ deleted: result.deleted, rejected: result.rejected });
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
