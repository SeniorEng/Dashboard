import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { timeTrackingStorage } from "../storage/time-tracking";
import { closeMonthSchema, reopenMonthSchema } from "@shared/schema";
import { generateAutoBreaksForMonth, insertAutoBreaks, previewAutoBreaksForMonth, removeAutoBreaksForMonth } from "../services/auto-breaks";

const router = Router();
router.use(requireAuth);

router.get("/month-closings/admin/:year/:month", requireAdmin, asyncHandler("Monatsabschlüsse konnten nicht geladen werden", async (req, res) => {
  const year = parseInt(req.params.year);
  const month = parseInt(req.params.month);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const closings = await timeTrackingStorage.getAdminMonthClosings(year, month);
  res.json({ closings });
}));

router.get("/month-closing/:year/:month", asyncHandler("Monatsabschluss konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const year = parseInt(req.params.year);
  const month = parseInt(req.params.month);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const closing = await timeTrackingStorage.getMonthClosing(userId, year, month);
  res.json({ closing: closing || null });
}));

router.get("/month-closing/:year/:month/preview", asyncHandler("Vorschau konnte nicht erstellt werden", async (req, res) => {
  const userId = req.user!.id;
  const year = parseInt(req.params.year);
  const month = parseInt(req.params.month);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    throw badRequest("Ungültiges Jahr oder Monat");
  }

  const autoBreaks = await previewAutoBreaksForMonth(userId, year, month);
  res.json({ autoBreaks });
}));

router.post("/close-month", asyncHandler("Monatsabschluss fehlgeschlagen", async (req, res) => {
  const userId = req.user!.id;
  const parsed = closeMonthSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Ungültige Eingabe");
  }

  const { year, month } = parsed.data;

  const existing = await timeTrackingStorage.getMonthClosing(userId, year, month);
  if (existing && !existing.reopenedAt) {
    throw badRequest("Dieser Monat ist bereits abgeschlossen.");
  }

  const autoBreaks = await generateAutoBreaksForMonth(userId, year, month);
  const insertedCount = await insertAutoBreaks(userId, autoBreaks);

  await timeTrackingStorage.closeMonth(userId, year, month, userId, existing?.id);

  res.json({
    message: `Monat ${month}/${year} abgeschlossen`,
    autoBreaksInserted: insertedCount,
  });
}));

router.post("/reopen-month", requireAdmin, asyncHandler("Monat konnte nicht wieder geöffnet werden", async (req, res) => {
  const parsed = reopenMonthSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Ungültige Eingabe: year, month und userId erforderlich");
  }

  const { year, month, userId: targetUserId } = parsed.data;

  const existing = await timeTrackingStorage.getMonthClosing(targetUserId, year, month);
  if (!existing || existing.reopenedAt) {
    throw badRequest("Dieser Monat ist nicht abgeschlossen.");
  }

  await timeTrackingStorage.reopenMonth(existing.id, req.user!.id);
  await removeAutoBreaksForMonth(targetUserId, year, month);

  res.json({ message: `Monat ${month}/${year} wieder geöffnet` });
}));

export default router;
