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
import { csrfProtection, csrfTokenHandler } from "../middleware/csrf";
import { authMiddleware } from "../middleware/auth";
import { cacheHeaders } from "../middleware/cache-headers";

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

export default router;
