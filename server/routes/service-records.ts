import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, canAccessCustomer } from "../middleware/auth";
import { insertServiceRecordSchema, insertSingleServiceRecordSchema, signServiceRecordSchema, serviceRecordAppointments, monthlyServiceRecords, appointments, invoiceLineItems, invoices as invoicesTable } from "@shared/schema";
import { asyncHandler, sendForbidden, sendNotFound, sendConflict } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { db } from "../lib/db";
import { eq, and, isNull, ne, inArray } from "drizzle-orm";
import { getPrimaryCustomerIds } from "../storage/customers-storage";

const router = Router();

async function requireServiceRecordAccess(req: Request, res: Response, id: number) {
  const record = await storage.getServiceRecord(id);
  if (!record) {
    res.status(404).json({ message: "Leistungsnachweis nicht gefunden" });
    return null;
  }
  const hasAccess = await canAccessCustomer(
    req.user!.id,
    req.user!.isAdmin,
    record.customerId,
    (employeeId) => storage.getAssignedCustomerIds(employeeId)
  );
  if (!hasAccess) {
    res.status(403).json({ error: "FORBIDDEN", message: "Sie haben keinen Zugriff auf diesen Leistungsnachweis" });
    return null;
  }
  return record;
}

router.get("/", requireAuth, asyncHandler("Leistungsnachweise konnten nicht geladen werden", async (req, res) => {
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : null;
  const effectiveUserId = (req.user!.isAdmin && viewAsEmployeeId) ? viewAsEmployeeId : req.user!.id;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  
  const records = await storage.getServiceRecordsForEmployee(effectiveUserId, year, month, customerId);
  res.json(records);
}));

router.get("/pending", requireAuth, asyncHandler("Ausstehende Leistungsnachweise konnten nicht geladen werden", async (req, res) => {
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : null;
  const effectiveUserId = (req.user!.isAdmin && viewAsEmployeeId) ? viewAsEmployeeId : req.user!.id;
  const records = await storage.getPendingServiceRecords(effectiveUserId);
  res.json(records);
}));

router.get("/employee-names", requireAuth, asyncHandler("Mitarbeiternamen konnten nicht geladen werden", async (req, res) => {
  const allUsers = await authService.getAllUsers();
  const names = allUsers.map(u => ({ id: u.id, displayName: u.displayName }));
  res.json(names);
}));

router.get("/overview", requireAuth, asyncHandler("Übersicht konnte nicht geladen werden", async (req, res) => {
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : null;
  const effectiveUserId = (req.user!.isAdmin && viewAsEmployeeId) ? viewAsEmployeeId : req.user!.id;
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  
  if (isNaN(year) || isNaN(month)) {
    return res.status(400).json({ message: "Jahr und Monat sind erforderlich" });
  }
  
  const overviewData = await storage.getServiceRecordsOverview(effectiveUserId, year, month);
  
  const overview = overviewData.map(item => {
    let status: "undocumented" | "ready" | "pending" | "employee_signed" | "completed";
    
    const hasSingleRecords = (item.singleRecords ?? []).length > 0;
    const hasMonthlyRecord = !!item.existingRecordId;
    const coveredCount = (item.coveredBySingleCount ?? 0) + (item.coveredByMonthlyCount ?? 0);
    const uncoveredDocumentedCount = Math.max(0, item.documentedCount - coveredCount);

    if (item.undocumentedCount > 0) {
      status = "undocumented";
    } else if (uncoveredDocumentedCount > 0) {
      status = "ready";
    } else if (item.existingRecordId) {
      status = item.existingRecordStatus as "pending" | "employee_signed" | "completed";
    } else if (hasSingleRecords) {
      const allCompleted = (item.singleRecords ?? []).every(r => r.status === "completed");
      status = allCompleted ? "completed" : "pending";
    } else {
      status = "ready";
    }
    
    const canCreateRecord = item.undocumentedCount === 0 
      && item.documentedCount > 0 
      && uncoveredDocumentedCount > 0;

    return {
      customerId: item.customerId,
      customerName: item.customerName,
      existingRecord: item.existingRecordId ? { id: item.existingRecordId, status: item.existingRecordStatus } : null,
      singleRecords: item.singleRecords ?? [],
      documentedCount: item.documentedCount,
      undocumentedCount: item.undocumentedCount,
      totalAppointments: item.totalAppointments,
      coveredBySingleCount: item.coveredBySingleCount ?? 0,
      coveredByMonthlyCount: item.coveredByMonthlyCount ?? 0,
      uncoveredDocumentedCount,
      status,
      canCreateRecord,
    };
  });
  
  const statusOrder = ["undocumented", "ready", "pending", "employee_signed", "completed"];
  overview.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  
  res.json(overview);
}));

router.get("/check-period", requireAuth, asyncHandler("Periodendaten konnten nicht geladen werden", async (req, res) => {
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : null;
  const effectiveUserId = (req.user!.isAdmin && viewAsEmployeeId) ? viewAsEmployeeId : req.user!.id;
  const customerId = parseInt(req.query.customerId as string);
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  
  if (isNaN(customerId) || isNaN(year) || isNaN(month)) {
    return res.status(400).json({ message: "Ungültige Parameter" });
  }
  
  const hasAccess = await canAccessCustomer(
    effectiveUserId,
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

  const primaryIds = await getPrimaryCustomerIds(effectiveUserId);
  const isPrimary = primaryIds.includes(customerId);
  
  const [existingRecord, counts, customerData, coveredBySingleCount, coveredByMonthlyCount] = await Promise.all([
    storage.getServiceRecordByPeriod(customerId, effectiveUserId, year, month, isPrimary),
    storage.getAppointmentCountsForPeriod(customerId, effectiveUserId, year, month, isPrimary),
    storage.getCustomer(customerId),
    storage.getCoveredBySingleCount(customerId, effectiveUserId, year, month, isPrimary),
    storage.getCoveredByMonthlyCount(customerId, effectiveUserId, year, month, isPrimary),
  ]);

  const coveredCount = coveredBySingleCount + coveredByMonthlyCount;
  const uncoveredDocumentedCount = Math.max(0, counts.documentedCount - coveredCount);
  
  res.json({
    existingRecord,
    documentedCount: counts.documentedCount,
    undocumentedCount: counts.undocumentedCount,
    coveredBySingleCount,
    coveredByMonthlyCount,
    uncoveredDocumentedCount,
    canCreateRecord: counts.undocumentedCount === 0 && counts.documentedCount > 0 && uncoveredDocumentedCount > 0,
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
  
  const record = await requireServiceRecordAccess(req, res, id);
  if (!record) return;
  
  res.json(record);
}));

router.get("/:id/appointments", requireAuth, asyncHandler("Termine konnten nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
  const record = await requireServiceRecordAccess(req, res, id);
  if (!record) return;
  
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
  const effectiveEmployeeId = req.user!.isAdmin ? parsed.data.employeeId : userId;
  
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

  const primaryIds = await getPrimaryCustomerIds(effectiveEmployeeId);
  const isPrimary = primaryIds.includes(customerId);
  
  const undocumentedAppointments = await storage.getUndocumentedAppointmentsForPeriod(customerId, effectiveEmployeeId, year, month, isPrimary);
  if (undocumentedAppointments.length > 0) {
    return res.status(400).json({ 
      message: `Es gibt noch ${undocumentedAppointments.length} nicht dokumentierte Termine in diesem Monat. Bitte dokumentieren Sie alle Termine, bevor Sie den Leistungsnachweis erstellen.`,
      undocumentedCount: undocumentedAppointments.length
    });
  }
  
  const documentedAppointments = await storage.getDocumentedAppointmentsForPeriod(customerId, effectiveEmployeeId, year, month, isPrimary);
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
      message: "Alle dokumentierten Termine sind bereits durch bestehende Leistungsnachweise abgedeckt." 
    });
  }
  
  const appointmentIds = remainingAppointments.map(apt => apt.id);

  const record = await db.transaction(async (tx) => {
    const rec = await storage.createServiceRecord({
      customerId,
      employeeId: effectiveEmployeeId,
      year,
      month,
      recordType: "monthly",
    }, tx);

    await storage.addAppointmentsToServiceRecord(rec.id, appointmentIds, tx);

    const ip = req.ip || req.socket.remoteAddress;
    await auditService.serviceRecordCreated(
      userId,
      rec.id,
      { customerId, year, month, appointmentCount: appointmentIds.length },
      ip
    );

    return rec;
  });

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
  
  const appointmentEmployeeId = appointment.performedByEmployeeId || appointment.assignedEmployeeId || userId;
  
  const record = await db.transaction(async (tx) => {
    const rec = await storage.createServiceRecord({
      customerId,
      employeeId: appointmentEmployeeId,
      year,
      month,
      recordType: "single",
    }, tx);

    await storage.addAppointmentsToServiceRecord(rec.id, [appointmentId], tx);

    const ip = req.ip || req.socket.remoteAddress;
    await auditService.serviceRecordCreated(
      userId,
      rec.id,
      { customerId, year, month, appointmentCount: 1, recordType: "single", appointmentId },
      ip
    );

    return rec;
  });

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
    appointment.customerId!,
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

router.get("/:id/check-invoiced", requireAuth, asyncHandler("Abrechnungsstatus konnte nicht geprüft werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const record = await storage.getServiceRecord(id);
  if (!record) {
    return sendNotFound(res, "Leistungsnachweis nicht gefunden.");
  }

  const hasAccess = await canAccessCustomer(
    req.user!.id,
    req.user!.isAdmin,
    record.customerId,
    (employeeId) => storage.getAssignedCustomerIds(employeeId)
  );
  if (!hasAccess) {
    return sendForbidden(res, "FORBIDDEN", "Kein Zugriff auf diesen Leistungsnachweis.");
  }

  const linkedAppointments = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(eq(serviceRecordAppointments.serviceRecordId, id));
  const linkedAppointmentIds = linkedAppointments.map(r => r.appointmentId);

  let isInvoiced = false;
  if (linkedAppointmentIds.length > 0) {
    const invoicedRows = await db.select({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems)
      .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
      .where(and(
        inArray(invoiceLineItems.appointmentId, linkedAppointmentIds),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung")
      ));
    isInvoiced = invoicedRows.length > 0;
  }

  res.json({ isInvoiced });
}));

router.delete("/:id", requireAuth, asyncHandler("Leistungsnachweis konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const record = await storage.getServiceRecord(id);
  if (!record) {
    return sendNotFound(res, "Leistungsnachweis nicht gefunden.");
  }

  const isOwner = record.employeeId === req.user!.id;
  if (!req.user!.isAdmin && !isOwner) {
    return sendForbidden(res, "FORBIDDEN", "Sie können nur Ihre eigenen Leistungsnachweise löschen.");
  }

  let linkedAppointmentIds: number[];
  try {
    linkedAppointmentIds = await db.transaction(async (tx) => {
    const linkedAppointments = await tx.select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, id));
    const aptIds = linkedAppointments.map(r => r.appointmentId);

    if (aptIds.length > 0) {
      const invoicedRows = await tx.select({ appointmentId: invoiceLineItems.appointmentId })
        .from(invoiceLineItems)
        .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
        .where(and(
          inArray(invoiceLineItems.appointmentId, aptIds),
          ne(invoicesTable.status, "storniert"),
          ne(invoicesTable.invoiceType, "stornorechnung")
        ));
      if (invoicedRows.length > 0) {
        throw new Error("INVOICED");
      }
    }

    await tx.delete(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, id));

    if (aptIds.length > 0) {
      await tx.update(appointments)
        .set({ status: "documenting" })
        .where(inArray(appointments.id, aptIds));
    }

    await tx.update(monthlyServiceRecords)
      .set({ deletedAt: new Date() })
      .where(eq(monthlyServiceRecords.id, id));

    return aptIds;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVOICED") {
      return sendConflict(res, "INVOICED", "Dieser Leistungsnachweis kann nicht gelöscht werden, da Termine bereits abgerechnet wurden.");
    }
    throw error;
  }

  await auditService.log(
    req.user!.id,
    "service_record_deleted",
    "service_record",
    id,
    {
      customerId: record.customerId,
      employeeId: record.employeeId,
      year: record.year,
      month: record.month,
      status: record.status,
      affectedAppointmentIds: linkedAppointmentIds,
      deletedBy: req.user!.id,
    }
  );

  res.json({ success: true, message: "Leistungsnachweis gelöscht. Die zugehörigen Termine stehen wieder zur Bearbeitung bereit." });
}));

export default router;
