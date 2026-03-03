import { Router } from "express";
import appointmentsRouter from "./appointments";
import customersRouter from "./customers";
import authRouter from "./auth";
import adminRouter from "./admin";
import timeEntriesRouter from "./time-entries";
import birthdaysRouter from "./birthdays";
import birthdayCardsRouter from "./birthday-cards";
import budgetRouter from "./budget";
import tasksRouter from "./tasks";
import serviceRecordsRouter from "./service-records";
import servicesRouter from "./services";
import { searchRouter } from "./search";
import settingsRouter from "./settings";
import profileRouter from "./profile";
import companyRouter from "./company";
import billingRouter from "./billing";
import holidaysRouter from "./holidays";
import statisticsRouter from "./statistics";
import webhookRouter from "./webhook";
import notificationsRouter from "./notifications";
import { csrfProtection, csrfTokenHandler } from "../middleware/csrf";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { cacheHeaders } from "../middleware/cache-headers";
import { asyncHandler, sendForbidden, sendNotFound } from "../lib/errors";
import { db } from "../lib/db";
import { serviceRecordAppointments, monthlyServiceRecords } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "../storage";
import { auditService } from "../services/audit";

const router = Router();

router.use("/webhook", webhookRouter);

router.get("/health", async (_req, res) => {
  try {
    const { pool } = await import("../lib/db");
    await pool.query("SELECT 1");
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "error", message: "Database connection failed" });
  }
});

router.get("/public/branding", async (_req, res) => {
  try {
    const { storage } = await import("../storage");
    const settings = await storage.getCompanySettings();
    res.json({
      logoUrl: settings?.logoUrl ? "/api/public/logo/main" : null,
      pdfLogoUrl: settings?.pdfLogoUrl ? "/api/public/logo/pdf" : null,
      companyName: settings?.companyName || null,
    });
  } catch {
    res.json({ logoUrl: null, pdfLogoUrl: null, companyName: null });
  }
});

router.get("/public/logo/:type", async (req, res) => {
  try {
    const { storage } = await import("../storage");
    const settings = await storage.getCompanySettings();
    const logoPath = req.params.type === "pdf" ? settings?.pdfLogoUrl : settings?.logoUrl;
    if (!logoPath) {
      return res.status(404).json({ error: "Logo not found" });
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
    const objectStorageService = new ObjectStorageService();
    const objectFile = await objectStorageService.getObjectEntityFile(logoPath);
    await objectStorageService.downloadObject(objectFile, res);
  } catch {
    res.status(404).json({ error: "Logo not found" });
  }
});

router.use(authMiddleware);
router.use(cacheHeaders);

router.get("/csrf-token", csrfTokenHandler);

router.use("/auth", authRouter);

router.get("/admin/cleanup-service-record/:id", requireAuth, asyncHandler("Fehler beim Bereinigen", async (req, res) => {
  if (!req.user?.isAdmin) {
    return sendForbidden(res, "FORBIDDEN", "Nur Admins.");
  }
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).send("Ungültige ID");
  }
  const record = await storage.getServiceRecord(id);
  if (!record) {
    return res.send(`<h2>Leistungsnachweis #${id} nicht gefunden.</h2><p><a href="javascript:history.back()">Zurück</a></p>`);
  }

  const linkedAppts = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, id));

  await db.delete(serviceRecordAppointments).where(eq(serviceRecordAppointments.serviceRecordId, id));
  await db.delete(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, id));

  await auditService.log(
    req.user.id,
    "service_record_deleted",
    "service_record",
    id,
    { customerId: record.customerId, employeeId: record.employeeId, year: record.year, month: record.month, status: record.status, linkedAppointments: linkedAppts.map(a => a.appointmentId) }
  );

  res.send(`<h2>Leistungsnachweis #${id} gelöscht</h2><p>Status war: ${record.status}<br>Mitarbeiter: ${record.employeeId}, Kunde: ${record.customerId}<br>Zeitraum: ${record.month}/${record.year}<br>Verknüpfte Termine: ${linkedAppts.map(a => a.appointmentId).join(", ") || "keine"}</p><p><a href="javascript:history.back()">Zurück</a></p>`);
}));

router.use(csrfProtection);

router.use("/admin", adminRouter);

router.use("/appointments", appointmentsRouter);
router.use("/customers", customersRouter);
router.use("/time-entries", timeEntriesRouter);
router.use("/birthdays", birthdaysRouter);
router.use("/birthday-cards", birthdayCardsRouter);
router.use("/budget", budgetRouter);
router.use("/tasks", tasksRouter);
router.use("/service-records", serviceRecordsRouter);
router.use("/services", servicesRouter);
router.use("/search", searchRouter);
router.use("/settings", settingsRouter);
router.use("/profile", profileRouter);
router.use("/company-settings", companyRouter);
router.use("/billing", billingRouter);
router.use("/holidays", holidaysRouter);
router.use("/statistics", statisticsRouter);
router.use("/notifications", notificationsRouter);

export default router;
