import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, canAccessCustomer } from "../middleware/auth";
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

// Overview of all assigned customers with their service record status for a period
router.get("/overview", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ message: "Jahr und Monat sind erforderlich" });
    }
    
    // Get all assigned customer IDs for this employee
    const assignedCustomerIds = await storage.getAssignedCustomerIds(userId);
    
    // Get overview data for each customer
    const overview = await Promise.all(
      assignedCustomerIds.map(async (customerId) => {
        const customer = await storage.getCustomer(customerId);
        if (!customer) return null;
        
        const existingRecord = await storage.getServiceRecordByPeriod(customerId, userId, year, month);
        const documentedAppointments = await storage.getDocumentedAppointmentsForPeriod(customerId, userId, year, month);
        const undocumentedAppointments = await storage.getUndocumentedAppointmentsForPeriod(customerId, userId, year, month);
        
        const totalAppointments = documentedAppointments.length + undocumentedAppointments.length;
        
        // Skip customers with no appointments and no existing record in this period
        // (they don't require any action for this month)
        if (totalAppointments === 0 && !existingRecord) {
          return null;
        }
        
        let status: "undocumented" | "ready" | "pending" | "employee_signed" | "completed";
        
        if (existingRecord) {
          status = existingRecord.status as "pending" | "employee_signed" | "completed";
        } else if (undocumentedAppointments.length > 0) {
          status = "undocumented";
        } else {
          status = "ready";
        }
        
        return {
          customerId,
          customerName: `${customer.vorname} ${customer.nachname}`,
          existingRecord,
          documentedCount: documentedAppointments.length,
          undocumentedCount: undocumentedAppointments.length,
          totalAppointments,
          status,
          canCreateRecord: !existingRecord && undocumentedAppointments.length === 0 && documentedAppointments.length > 0,
        };
      })
    );
    
    // Filter out null values and sort by status priority
    const statusOrder = ["undocumented", "ready", "pending", "employee_signed", "completed"];
    const filteredOverview = overview
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
    
    res.json(filteredOverview);
  } catch (error) {
    handleRouteError(res, error, "Übersicht konnte nicht geladen werden");
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
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      userId,
      req.user!.isAdmin,
      customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Kunden" 
      });
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
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      req.user!.id,
      req.user!.isAdmin,
      customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Kunden" 
      });
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
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      req.user!.id,
      req.user!.isAdmin,
      record.customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Leistungsnachweis" 
      });
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
    
    // Erst den Service Record laden um die customerId zu prüfen
    const record = await storage.getServiceRecord(id);
    if (!record) {
      return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    }
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      req.user!.id,
      req.user!.isAdmin,
      record.customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diese Termine" 
      });
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
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      userId,
      req.user!.isAdmin,
      customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Kunden" 
      });
    }
    
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
    
    // Erst den Service Record laden um die customerId zu prüfen
    const existingRecord = await storage.getServiceRecord(id);
    if (!existingRecord) {
      return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    }
    
    // Autorisierungsprüfung: Nur zugewiesene Kunden oder Admin
    const hasAccess = await canAccessCustomer(
      req.user!.id,
      req.user!.isAdmin,
      existingRecord.customerId,
      (employeeId) => storage.getAssignedCustomerIds(employeeId)
    );
    if (!hasAccess) {
      return res.status(403).json({ 
        error: "FORBIDDEN",
        message: "Sie haben keinen Zugriff auf diesen Leistungsnachweis" 
      });
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
