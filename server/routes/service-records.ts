import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth } from "../middleware/auth";
import { insertServiceRecordSchema, signServiceRecordSchema } from "@shared/schema";
import { handleRouteError } from "../lib/errors";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const month = req.query.month ? parseInt(req.query.month as string) : undefined;
    const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
    
    const records = await storage.getServiceRecordsForEmployee(userId, year, month, customerId);
    res.json(records);
  } catch (error) {
    handleRouteError(res, error, "Leistungsnachweise konnten nicht geladen werden");
  }
});

router.get("/pending", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const records = await storage.getPendingServiceRecords(userId);
    res.json(records);
  } catch (error) {
    handleRouteError(res, error, "Ausstehende Leistungsnachweise konnten nicht geladen werden");
  }
});

router.get("/check-period", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const customerId = parseInt(req.query.customerId as string);
    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    
    if (isNaN(customerId) || isNaN(year) || isNaN(month)) {
      return res.status(400).json({ message: "Ungültige Parameter" });
    }
    
    const existingRecord = await storage.getServiceRecordByPeriod(customerId, userId, year, month);
    const documentedAppointments = await storage.getDocumentedAppointmentsForPeriod(customerId, userId, year, month);
    const undocumentedAppointments = await storage.getUndocumentedAppointmentsForPeriod(customerId, userId, year, month);
    
    res.json({
      existingRecord,
      documentedAppointments,
      undocumentedAppointments,
      canCreateRecord: undocumentedAppointments.length === 0 && documentedAppointments.length > 0,
    });
  } catch (error) {
    handleRouteError(res, error, "Periodendaten konnten nicht geladen werden");
  }
});

router.get("/customer/:customerId", requireAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (isNaN(customerId)) {
      return res.status(400).json({ message: "Ungültige Kunden-ID" });
    }
    
    const records = await storage.getServiceRecordsForCustomer(customerId);
    res.json(records);
  } catch (error) {
    handleRouteError(res, error, "Leistungsnachweise konnten nicht geladen werden");
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Ungültige ID" });
    }
    
    const record = await storage.getServiceRecord(id);
    if (!record) {
      return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    }
    
    res.json(record);
  } catch (error) {
    handleRouteError(res, error, "Leistungsnachweis konnte nicht geladen werden");
  }
});

router.get("/:id/appointments", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Ungültige ID" });
    }
    
    const appointments = await storage.getAppointmentsForServiceRecord(id);
    res.json(appointments);
  } catch (error) {
    handleRouteError(res, error, "Termine konnten nicht geladen werden");
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const parsed = insertServiceRecordSchema.safeParse(req.body);
    
    if (!parsed.success) {
      return res.status(400).json({ 
        message: "Ungültige Eingabedaten",
        errors: parsed.error.errors 
      });
    }
    
    const { customerId, year, month } = parsed.data;
    
    const existingRecord = await storage.getServiceRecordByPeriod(customerId, userId, year, month);
    if (existingRecord) {
      return res.status(409).json({ 
        message: "Für diesen Zeitraum existiert bereits ein Leistungsnachweis" 
      });
    }
    
    const undocumentedAppointments = await storage.getUndocumentedAppointmentsForPeriod(customerId, userId, year, month);
    if (undocumentedAppointments.length > 0) {
      return res.status(400).json({ 
        message: `Es gibt noch ${undocumentedAppointments.length} nicht dokumentierte Termine in diesem Monat. Bitte dokumentieren Sie alle Termine, bevor Sie den Leistungsnachweis erstellen.`,
        undocumentedCount: undocumentedAppointments.length
      });
    }
    
    const documentedAppointments = await storage.getDocumentedAppointmentsForPeriod(customerId, userId, year, month);
    if (documentedAppointments.length === 0) {
      return res.status(400).json({ 
        message: "Es gibt keine dokumentierten Termine in diesem Monat." 
      });
    }
    
    const record = await storage.createServiceRecord({
      customerId,
      employeeId: userId,
      year,
      month,
    });
    
    const appointmentIds = documentedAppointments.map(apt => apt.id);
    await storage.addAppointmentsToServiceRecord(record.id, appointmentIds);
    
    res.status(201).json(record);
  } catch (error) {
    handleRouteError(res, error, "Leistungsnachweis konnte nicht erstellt werden");
  }
});

router.post("/:id/sign", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Ungültige ID" });
    }
    
    const parsed = signServiceRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ 
        message: "Ungültige Eingabedaten",
        errors: parsed.error.errors 
      });
    }
    
    const { signatureData, signerType } = parsed.data;
    
    const record = await storage.signServiceRecord(id, signatureData, signerType);
    if (!record) {
      return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    }
    
    res.json(record);
  } catch (error) {
    if (error instanceof Error && error.message.includes("kann nur")) {
      return res.status(400).json({ message: error.message });
    }
    handleRouteError(res, error, "Unterschrift konnte nicht gespeichert werden");
  }
});

export default router;
