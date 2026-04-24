import { Router, Request, Response } from "express";
import { z } from "zod";
import { inArray, eq, and, gte, lte, isNull } from "drizzle-orm";
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

export default router;
