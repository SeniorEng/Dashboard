import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, canAccessCustomer } from "../middleware/auth";
import { insertServiceRecordSchema, insertSingleServiceRecordSchema, signServiceRecordSchema, serviceRecordAppointments, monthlyServiceRecords, appointments } from "@shared/schema";
import { asyncHandler, sendForbidden, sendNotFound } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { db } from "../lib/db";
import { eq, and, isNull } from "drizzle-orm";

const router = Router();

router.get("/", requireAuth, asyncHandler("Leistungsnachweise konnten nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  
  const records = await storage.getServiceRecordsForEmployee(userId, year, month, customerId);
  res.json(records);
}));

router.get("/pending", requireAuth, asyncHandler("Ausstehende Leistungsnachweise konnten nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const records = await storage.getPendingServiceRecords(userId);
  res.json(records);
}));

router.get("/employee-names", requireAuth, asyncHandler("Mitarbeiternamen konnten nicht geladen werden", async (req, res) => {
  const allUsers = await authService.getAllUsers();
  const names = allUsers.map(u => ({ id: u.id, displayName: u.displayName }));
  res.json(names);
}));

router.get("/overview", requireAuth, asyncHandler("Übersicht konnte nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  
  if (isNaN(year) || isNaN(month)) {
    return res.status(400).json({ message: "Jahr und Monat sind erforderlich" });
  }
  
  const overviewData = await storage.getServiceRecordsOverview(userId, year, month);
  
  const overview = overviewData.map(item => {
    let status: "undocumented" | "ready" | "pending" | "employee_signed" | "completed";
    
    if (item.existingRecordId) {
      status = item.existingRecordStatus as "pending" | "employee_signed" | "completed";
    } else if (item.undocumentedCount > 0) {
      status = "undocumented";
    } else {
      status = "ready";
    }

    const hasSingleRecords = (item.singleRecords ?? []).length > 0;
    const hasMonthlyRecord = !!item.existingRecordId;
    
    return {
      customerId: item.customerId,
      customerName: item.customerName,
      existingRecord: item.existingRecordId ? { id: item.existingRecordId, status: item.existingRecordStatus } : null,
      singleRecords: item.singleRecords ?? [],
      documentedCount: item.documentedCount,
      undocumentedCount: item.undocumentedCount,
      totalAppointments: item.totalAppointments,
      coveredBySingleCount: item.coveredBySingleCount,
      status,
      canCreateRecord: !hasMonthlyRecord && item.undocumentedCount === 0 && item.documentedCount > 0,
    };
  });
  
  const statusOrder = ["undocumented", "ready", "pending", "employee_signed", "completed"];
  overview.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  
  res.json(overview);
}));

router.get("/check-period", requireAuth, asyncHandler("Periodendaten konnten nicht geladen werden", async (req, res) => {
  const userId = req.user!.id;
  const customerId = parseInt(req.query.customerId as string);
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  
  if (isNaN(customerId) || isNaN(year) || isNaN(month)) {
    return res.status(400).json({ message: "Ungültige Parameter" });
  }
  
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
  
  const [existingRecord, counts, customerData] = await Promise.all([
    storage.getServiceRecordByPeriod(customerId, userId, year, month),
    storage.getAppointmentCountsForPeriod(customerId, userId, year, month),
    storage.getCustomer(customerId),
  ]);

  const coveredBySingleCount = await storage.getCoveredBySingleCount(customerId, userId, year, month);

  const isErstberatung = customerData?.status === "erstberatung";
  
  res.json({
    existingRecord,
    documentedCount: counts.documentedCount,
    undocumentedCount: counts.undocumentedCount,
    coveredBySingleCount,
    canCreateRecord: !isErstberatung && counts.undocumentedCount === 0 && counts.documentedCount > 0,
    isErstberatung,
  });
}));

router.get("/customer/:customerId", requireAuth, asyncHandler("Leistungsnachweise konnten nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  
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
}));

router.get("/:id", requireAuth, asyncHandler("Leistungsnachweis konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const record = await storage.getServiceRecord(id);
  if (!record) {
    return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
  }
  
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
}));

router.get("/:id/appointments", requireAuth, asyncHandler("Termine konnten nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const record = await storage.getServiceRecord(id);
  if (!record) {
    return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
  }
  
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
}));

router.post("/", requireAuth, asyncHandler("Leistungsnachweis konnte nicht erstellt werden", async (req, res) => {
  const userId = req.user!.id;
  const parsed = insertServiceRecordSchema.safeParse(req.body);
  
  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Ungültige Eingabedaten",
      errors: parsed.error.errors 
    });
  }
  
  const { customerId, year, month } = parsed.data;
  
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
  
  const customer = await storage.getCustomer(customerId);
  if (customer?.status === "erstberatung") {
    return res.status(400).json({
      message: "Für Erstberatungskunden können keine Leistungsnachweise erstellt werden. Erst nach Vertragsabschluss ist eine Abrechnung möglich."
    });
  }

  const existingRecord = await storage.getServiceRecordByPeriod(customerId, userId, year, month);
  if (existingRecord) {
    return res.status(409).json({ 
      message: "Für diesen Zeitraum existiert bereits ein monatlicher Leistungsnachweis" 
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

  const allApptIds = documentedAppointments.map(apt => apt.id);
  const alreadyCoveredIds = await storage.getAppointmentIdsInServiceRecords(allApptIds);
  const remainingAppointments = documentedAppointments.filter(apt => !alreadyCoveredIds.includes(apt.id));
  
  if (remainingAppointments.length === 0) {
    return res.status(400).json({ 
      message: "Alle dokumentierten Termine sind bereits durch Einzel-Leistungsnachweise abgedeckt." 
    });
  }
  
  const record = await storage.createServiceRecord({
    customerId,
    employeeId: userId,
    year,
    month,
    recordType: "monthly",
  });
  
  const appointmentIds = remainingAppointments.map(apt => apt.id);
  await storage.addAppointmentsToServiceRecord(record.id, appointmentIds);

  const ip = req.ip || req.socket.remoteAddress;
  await auditService.serviceRecordCreated(
    userId,
    record.id,
    { customerId, year, month, appointmentCount: appointmentIds.length },
    ip
  );

  res.status(201).json(record);
}));

router.post("/single", requireAuth, asyncHandler("Einzeltermin-Leistungsnachweis konnte nicht erstellt werden", async (req, res) => {
  const userId = req.user!.id;
  const parsed = insertSingleServiceRecordSchema.safeParse(req.body);
  
  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Ungültige Eingabedaten",
      errors: parsed.error.errors 
    });
  }
  
  const { customerId, appointmentId } = parsed.data;
  
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
  
  const customer = await storage.getCustomer(customerId);
  if (customer?.status === "erstberatung") {
    return res.status(400).json({
      message: "Für Erstberatungskunden können keine Leistungsnachweise erstellt werden."
    });
  }

  const [appointment] = await db.select()
    .from(appointments)
    .where(and(
      eq(appointments.id, appointmentId),
      eq(appointments.customerId, customerId),
      isNull(appointments.deletedAt)
    ))
    .limit(1);
  
  if (!appointment) {
    return res.status(404).json({ message: "Termin nicht gefunden" });
  }
  
  if (appointment.status !== "completed") {
    return res.status(400).json({ 
      message: "Nur abgeschlossene Termine können einen Leistungsnachweis erhalten." 
    });
  }

  const existingRecord = await storage.getServiceRecordForAppointment(appointmentId);
  if (existingRecord) {
    return res.status(409).json({ 
      message: "Für diesen Termin existiert bereits ein Leistungsnachweis.",
      existingRecordId: existingRecord.id
    });
  }

  const appointmentDate = new Date(appointment.date as string);
  const year = appointmentDate.getFullYear();
  const month = appointmentDate.getMonth() + 1;
  
  const record = await storage.createServiceRecord({
    customerId,
    employeeId: userId,
    year,
    month,
    recordType: "single",
  });
  
  await storage.addAppointmentsToServiceRecord(record.id, [appointmentId]);

  const ip = req.ip || req.socket.remoteAddress;
  await auditService.serviceRecordCreated(
    userId,
    record.id,
    { customerId, year, month, appointmentCount: 1, recordType: "single", appointmentId },
    ip
  );

  res.status(201).json(record);
}));

router.get("/for-appointment/:appointmentId", requireAuth, asyncHandler("Leistungsnachweis konnte nicht geladen werden", async (req, res) => {
  const appointmentId = requireIntParam(req.params.appointmentId, res);
  if (appointmentId === null) return;

  const [appointment] = await db.select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), isNull(appointments.deletedAt)))
    .limit(1);
  
  if (!appointment) {
    return res.status(404).json({ message: "Termin nicht gefunden" });
  }

  const hasAccess = await canAccessCustomer(
    req.user!.id,
    req.user!.isAdmin,
    appointment.customerId,
    (employeeId) => storage.getAssignedCustomerIds(employeeId)
  );
  if (!hasAccess) {
    return res.status(403).json({ error: "FORBIDDEN", message: "Kein Zugriff" });
  }
  
  const record = await storage.getServiceRecordForAppointment(appointmentId);
  res.json(record || null);
}));

router.post("/:id/sign", requireAuth, asyncHandler("Unterschrift konnte nicht gespeichert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const existingRecord = await storage.getServiceRecord(id);
  if (!existingRecord) {
    return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
  }
  
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

  const linkedAppointments = await storage.getAppointmentsForServiceRecord(id);
  const nonCompletedAppointments = linkedAppointments.filter(a => a.status !== "completed");
  if (nonCompletedAppointments.length > 0) {
    const details = nonCompletedAppointments.slice(0, 3).map(a => `${a.date} (${a.status})`).join(", ");
    return res.status(400).json({
      message: `Der Leistungsnachweis kann nicht unterschrieben werden: ${nonCompletedAppointments.length} Termin(e) sind nicht mehr im Status 'abgeschlossen'. Betroffene Termine: ${details}`
    });
  }
  
  const { signatureData, signerType, signingLocation } = parsed.data;
  const signingIp = req.ip || req.socket.remoteAddress || null;
  
  try {
    const record = await storage.signServiceRecord(id, signatureData, signerType, req.user!.id, signingIp, signingLocation);
    if (!record) {
      return res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    }

    const ip = req.ip || req.socket.remoteAddress;
    await auditService.serviceRecordSigned(
      req.user!.id,
      id,
      signerType,
      { customerId: existingRecord.customerId },
      ip
    );

    res.json(record);
  } catch (error) {
    if (error instanceof Error && error.message.includes("kann nur")) {
      return res.status(400).json({ message: error.message });
    }
    throw error;
  }
}));

router.delete("/:id", requireAuth, asyncHandler("Leistungsnachweis konnte nicht gelöscht werden", async (req, res) => {
  if (!req.user?.isAdmin) {
    return sendForbidden(res, "FORBIDDEN", "Nur Admins können Leistungsnachweise löschen.");
  }

  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const record = await storage.getServiceRecord(id);
  if (!record) {
    return sendNotFound(res, "Leistungsnachweis nicht gefunden.");
  }

  await db.update(monthlyServiceRecords)
    .set({ deletedAt: new Date() })
    .where(eq(monthlyServiceRecords.id, id));

  await auditService.log(
    req.user.id,
    "service_record_deleted",
    "service_record",
    id,
    { customerId: record.customerId, employeeId: record.employeeId, year: record.year, month: record.month, status: record.status }
  );

  res.json({ success: true, message: "Leistungsnachweis gelöscht" });
}));

export default router;
