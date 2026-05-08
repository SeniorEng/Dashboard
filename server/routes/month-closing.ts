import { Router } from "express";
import { requireAuth, requireAdmin, requireSuperAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { timeTrackingStorage } from "../storage/time-tracking";
import { reopenMonthSchema, adminCloseMonthSchema } from "@shared/schema";
import { auditService } from "../services/audit";
import { generateAutoBreaksForMonth, insertAutoBreaks, previewAutoBreaksForMonth, removeAutoBreaksForMonth } from "../services/auto-breaks";
import { STATUS_LABELS } from "@shared/domain/appointments";
import { completeMonthClosingTask, reopenMonthClosingTask, ensureMonthClosingTask } from "../storage/tasks";
import { db } from "../lib/db";
import { z } from "zod";

const router = Router();
router.use(requireAuth);

function formatBlockerMessage(readiness: { openAppointments: Array<{ date: string; scheduledStart: string | null; status: string; customerName: string }>; unsignedAppointments: Array<{ date: string; scheduledStart: string | null; status: string; customerName: string }> }) {
  const messages: string[] = [];
  if (readiness.openAppointments.length > 0) {
    const appointmentList = readiness.openAppointments
      .slice(0, 5)
      .map(a => {
        const statusLabel = STATUS_LABELS[a.status as keyof typeof STATUS_LABELS] ?? a.status;
        return `${a.date}${a.scheduledStart ? ' ' + a.scheduledStart : ''} – ${a.customerName} (${statusLabel})`;
      })
      .join(", ");
    const more = readiness.openAppointments.length > 5
      ? ` und ${readiness.openAppointments.length - 5} weitere`
      : "";
    messages.push(`${readiness.openAppointments.length} offene(r) Termin(e): ${appointmentList}${more}`);
  }
  if (readiness.unsignedAppointments.length > 0) {
    const unsignedList = readiness.unsignedAppointments
      .slice(0, 5)
      .map(a => `${a.date}${a.scheduledStart ? ' ' + a.scheduledStart : ''} – ${a.customerName}`)
      .join(", ");
    const more = readiness.unsignedAppointments.length > 5
      ? ` und ${readiness.unsignedAppointments.length - 5} weitere`
      : "";
    messages.push(`${readiness.unsignedAppointments.length} Termin(e) ohne Unterschrift: ${unsignedList}${more}`);
  }
  return messages.join(". ");
}

router.get("/month-closings/admin/:year/:month", requireAdmin, asyncHandler("Monatsabschlüsse konnten nicht geladen werden", async (req, res) => {
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;

  if (month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const closings = await timeTrackingStorage.getAdminMonthClosings(year, month);
  res.json({ closings });
}));

router.get("/month-closings/admin/:year/:month/readiness", requireAdmin, asyncHandler("Admin-Bereitschaftsprüfung fehlgeschlagen", async (req, res) => {
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;

  if (month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const results = await timeTrackingStorage.getAdminMonthClosingReadiness(year, month);
  res.json({ employees: results });
}));

router.get("/month-closing/:year/:month", asyncHandler("Monatsabschluss konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;

  if (month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const closing = await timeTrackingStorage.getMonthClosing(userId, year, month);
  res.json({ closing: closing || null });
}));

router.get("/month-closing/:year/:month/readiness", asyncHandler("Bereitschaftsprüfung fehlgeschlagen", async (req, res) => {
  const userId = req.user!.id;
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;

  if (month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const readiness = await timeTrackingStorage.getMonthClosingReadiness(userId, year, month);
  res.json(readiness);
}));

router.get("/month-closing/:year/:month/preview", asyncHandler("Vorschau konnte nicht erstellt werden", async (req, res) => {
  const userId = req.user!.id;
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;

  if (month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const autoBreaks = await previewAutoBreaksForMonth(userId, year, month);
  res.json({ autoBreaks });
}));

router.post("/admin/close-month", requireSuperAdmin, asyncHandler("Admin-Monatsabschluss fehlgeschlagen", async (req, res) => {
  const parsed = adminCloseMonthSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Ungültige Eingabe: year, month und userId erforderlich");
  }

  const { year, month, userId: targetUserId } = parsed.data;

  const existing = await timeTrackingStorage.getMonthClosing(targetUserId, year, month);
  if (existing && !existing.reopenedAt) {
    throw badRequest("Dieser Monat ist bereits abgeschlossen.");
  }

  const readiness = await timeTrackingStorage.getMonthClosingReadiness(targetUserId, year, month);

  if (!readiness.hasTimeEntries) {
    throw badRequest("Der Monat kann nicht abgeschlossen werden: Es sind keine Zeiteinträge oder abgeschlossene Termine vorhanden.");
  }

  if (readiness.openAppointments.length > 0 || readiness.unsignedAppointments.length > 0) {
    throw badRequest(`Der Monat kann nicht abgeschlossen werden: ${formatBlockerMessage(readiness)}`);
  }

  const autoBreaks = await generateAutoBreaksForMonth(targetUserId, year, month);

  const insertedCount = await db.transaction(async (tx) => {
    const count = await insertAutoBreaks(targetUserId, autoBreaks, tx);
    await timeTrackingStorage.closeMonth(targetUserId, year, month, req.user!.id, existing?.id, tx);
    await ensureMonthClosingTask(targetUserId, month, year, tx);
    await completeMonthClosingTask(targetUserId, month, year, tx);
    return count;
  });

  await auditService.log(req.user!.id, "admin_month_closed", "month_closing", targetUserId, {
    year,
    month,
    adminUserId: req.user!.id,
    targetUserId,
    autoBreaksInserted: insertedCount,
  }, req.ip);

  res.json({
    message: `Monat ${month}/${year} für Mitarbeiter abgeschlossen`,
    autoBreaksInserted: insertedCount,
  });
}));

const batchCloseSchema = z.object({
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12),
});

router.post("/admin/batch-close-month", requireSuperAdmin, asyncHandler("Batch-Monatsabschluss fehlgeschlagen", async (req, res) => {
  const parsed = batchCloseSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Ungültige Eingabe: year und month erforderlich");
  }

  const { year, month } = parsed.data;
  const adminUserId = req.user!.id;

  const allReadiness = await timeTrackingStorage.getAdminMonthClosingReadiness(year, month);
  const readyEmployees = allReadiness.filter(e => e.ready && !e.isClosed);

  if (readyEmployees.length === 0) {
    throw badRequest("Keine Mitarbeiter sind bereit für den Monatsabschluss.");
  }

  const results: Array<{ userId: number; displayName: string; autoBreaksInserted: number }> = [];

  for (const emp of readyEmployees) {
    const existing = emp.closingId
      ? await timeTrackingStorage.getMonthClosing(emp.userId, year, month)
      : null;

    const autoBreaks = await generateAutoBreaksForMonth(emp.userId, year, month);

    const insertedCount = await db.transaction(async (tx) => {
      const count = await insertAutoBreaks(emp.userId, autoBreaks, tx);
      await timeTrackingStorage.closeMonth(emp.userId, year, month, adminUserId, existing?.id, tx);
      await ensureMonthClosingTask(emp.userId, month, year, tx);
      await completeMonthClosingTask(emp.userId, month, year, tx);
      return count;
    });

    await auditService.log(adminUserId, "admin_month_closed", "month_closing", emp.userId, {
      year,
      month,
      adminUserId,
      targetUserId: emp.userId,
      autoBreaksInserted: insertedCount,
      batchClose: true,
    }, req.ip);

    results.push({ userId: emp.userId, displayName: emp.displayName, autoBreaksInserted: insertedCount });
  }

  res.json({
    message: `Monat ${month}/${year} für ${results.length} Mitarbeiter abgeschlossen`,
    closedCount: results.length,
    results,
  });
}));

router.post("/reopen-month", requireSuperAdmin, asyncHandler("Monat konnte nicht wieder geöffnet werden", async (req, res) => {
  const parsed = reopenMonthSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.errors[0]?.message ?? "Ungültige Eingabe: year, month, userId und reason erforderlich");
  }

  const { year, month, userId: targetUserId, reason } = parsed.data;

  const existing = await timeTrackingStorage.getMonthClosing(targetUserId, year, month);
  if (!existing || existing.reopenedAt) {
    throw badRequest("Dieser Monat ist nicht abgeschlossen.");
  }

  await timeTrackingStorage.reopenMonth(existing.id, req.user!.id);
  await removeAutoBreaksForMonth(targetUserId, year, month);

  await reopenMonthClosingTask(targetUserId, month, year);

  await auditService.log(req.user!.id, "month_reopened", "month_closing", targetUserId, {
    year,
    month,
    targetUserId,
    reason,
  }, req.ip);

  res.json({ message: `Monat ${month}/${year} wieder geöffnet` });
}));

router.get("/month-close/banner", asyncHandler("Banner-Status konnte nicht geladen werden", async (req, res) => {
  const { getMonthCloseBanner } = await import("../services/month-close-scheduler");
  const banner = await getMonthCloseBanner(req.user!.id);
  res.json({ banner });
}));

router.get("/month-close/cutoff/:year/:month", asyncHandler("Cutoff konnte nicht berechnet werden", async (req, res) => {
  const year = requireIntParam(req.params.year, res);
  const month = requireIntParam(req.params.month, res);
  if (year === null || month === null) return;
  if (month < 1 || month > 12) throw badRequest("Ungültiges Jahr oder Monat");
  const { computeMonthCloseCutoff } = await import("@shared/utils/month-close-cutoff");
  const cutoff = computeMonthCloseCutoff(year, month);
  res.json({ year, month, cutoff });
}));

export default router;
