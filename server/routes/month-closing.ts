import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { timeTrackingStorage } from "../storage/time-tracking";
import { previewAutoBreaksForMonth } from "../services/auto-breaks";

// Task #1496: Der Monatsabschluss erfolgt AUSSCHLIESSLICH automatisch am Cutoff
// (8., werktags-verschoben, 23:00 Berlin) über den Scheduler — unbedingt und für
// jeden Mitarbeiter mit Aktivität. Es gibt KEINEN manuellen Einzel-/Batch-Abschluss
// und KEIN Wieder-Öffnen mehr. Dieser Router stellt nur noch lesende Statusinfos
// (Abschluss-Status, Readiness als reine Anzeige, Auto-Pausen-Vorschau, Banner,
// Cutoff) bereit.

const router = Router();
router.use(requireAuth);

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

router.get("/month-closing/missing-signatures", requireAdmin, asyncHandler("Fehlende Unterschriften konnten nicht geladen werden", async (_req, res) => {
  // Task #1496: Aktive Liste „fehlende Unterschriften nach Abschluss" — rein
  // abgeleitet aus der „Dokumentiert"-Stufe, gefiltert auf geschlossene Monate.
  // Einträge verschwinden automatisch, sobald der Termin unterschrieben ist.
  const items = await timeTrackingStorage.getMissingSignaturesInClosedMonths();
  res.json({ items });
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
