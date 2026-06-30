import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, canAccessCustomer } from "../middleware/auth";
import { insertServiceRecordSchema, insertSingleServiceRecordSchema, signServiceRecordSchema, serviceRecordAppointments, monthlyServiceRecords, appointments, invoiceLineItems, invoices as invoicesTable, NO_SHOW_REASON_LABELS, type NoShowReason } from "@shared/schema";
import { asyncHandler, sendForbidden, sendNotFound, sendConflict, sendBadRequest } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { db } from "../lib/db";
import { appointmentsRepo } from "../repos";
import { eq, and, isNull, ne, inArray } from "drizzle-orm";
import { getPrimaryCustomerIds } from "../storage/customers-storage";
import { parseLocalDate } from "@shared/utils/datetime";
import { timeTrackingStorage } from "../storage/time-tracking";

function hasPgCode(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value
    && typeof (value as { code: unknown }).code === "string";
}

// Task #1528 — Doppel-Monats-LN-Schutz auf DB-Ebene: der partielle Unique-Index
// monthly_service_records_pending_unique_idx wirft 23505, wenn zwei parallele
// Create-Requests beide einen pending-LN für denselben Kunde+Mitarbeiter+Monat
// anlegen wollen. Der Verlierer fängt das ab und merged stattdessen.
function isUniqueViolation(err: unknown): boolean {
  if (hasPgCode(err) && err.code === "23505") return true;
  if (typeof err === "object" && err !== null && "cause" in err) {
    const cause = (err as { cause: unknown }).cause;
    if (hasPgCode(cause) && cause.code === "23505") return true;
  }
  return false;
}

async function ensureMonthOpenForRecord(
  record: { employeeId: number; year: number; month: number },
  user: { isSuperAdmin?: boolean | null },
): Promise<string | null> {
  if (user.isSuperAdmin) return null;
  const dateInMonth = `${record.year}-${String(record.month).padStart(2, "0")}-15`;
  const closed = await timeTrackingStorage.isMonthClosed(record.employeeId, dateInMonth);
  if (closed) {
    return "Der Monat ist bereits abgeschlossen. Nur die Geschäftsführung kann Änderungen vornehmen.";
  }
  return null;
}

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

    const monthlyRecords = item.monthlyRecords ?? [];
    const allRecords = [...monthlyRecords, ...(item.singleRecords ?? [])];
    const hasAnyRecord = allRecords.length > 0;
    // Representative status drives only the coarse server-side sort; the frontend
    // re-buckets from the full monthlyRecords/singleRecords arrays. A customer can
    // legitimately have several monthly proofs (one per employee, or an unsigned
    // one alongside a finished one) — we surface the most actionable (= first
    // not-yet-completed) so stuck proofs sort to the top.
    const pendingRecord = allRecords.find(r => r.status !== "completed");
    const coveredCount = (item.coveredBySingleCount ?? 0) + (item.coveredByMonthlyCount ?? 0);
    const uncoveredDocumentedCount = Math.max(0, item.documentedCount - coveredCount);

    if (item.undocumentedCount > 0) {
      status = "undocumented";
    } else if (uncoveredDocumentedCount > 0) {
      status = "ready";
    } else if (pendingRecord) {
      status = pendingRecord.status as "pending" | "employee_signed" | "completed";
    } else if (hasAnyRecord) {
      status = "completed";
    } else {
      status = "ready";
    }

    const canCreateRecord = item.undocumentedCount === 0
      && item.documentedCount > 0
      && uncoveredDocumentedCount > 0;

    return {
      customerId: item.customerId,
      customerName: item.customerName,
      monthlyRecords,
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
  
  const [existingRecord, counts, customerData, coveredBySingleCount, coveredByMonthlyCount, noShowAppointments] = await Promise.all([
    storage.getServiceRecordByPeriod(customerId, effectiveUserId, year, month, isPrimary),
    storage.getAppointmentCountsForPeriod(customerId, effectiveUserId, year, month, isPrimary),
    storage.getCustomer(customerId),
    storage.getCoveredBySingleCount(customerId, effectiveUserId, year, month, isPrimary),
    storage.getCoveredByMonthlyCount(customerId, effectiveUserId, year, month, isPrimary),
    storage.getNoShowAppointmentsForPeriod(customerId, effectiveUserId, year, month, isPrimary),
  ]);

  const coveredCount = coveredBySingleCount + coveredByMonthlyCount;
  const uncoveredDocumentedCount = Math.max(0, counts.documentedCount - coveredCount);

  // Task #1518 — No-Shows rein informativ aufbereiten. Sie erzeugen weder einen
  // Leistungsnachweis noch (außerhalb der Selbstzahler-„Vergebliche Anfahrt")
  // eine Abrechnung. `producesCharge` spiegelt exakt die Bedingung aus
  // `invoice-data.ts`: nur Selbstzahler mit Ausfall-Policy und ohne bewusste
  // Unterdrückung führen zu einer Privatrechnung.
  const noShows = noShowAppointments.map((appt) => {
    const reason = (appt.noShowReason ?? null) as NoShowReason | null;
    const producesCharge =
      customerData?.billingType === "selbstzahler" &&
      (customerData?.cancellationPolicyType ?? "none") !== "none" &&
      !appt.noShowChargeSuppressed;
    return {
      id: appt.id,
      date: appt.date,
      scheduledStart: appt.scheduledStart,
      scheduledEnd: appt.scheduledEnd,
      reason,
      reasonLabel: reason ? NO_SHOW_REASON_LABELS[reason] : null,
      reasonText: appt.noShowReasonText ?? null,
      notes: appt.noShowNotes ?? null,
      chargeSuppressed: appt.noShowChargeSuppressed,
      producesCharge,
    };
  });

  res.json({
    existingRecord,
    documentedCount: counts.documentedCount,
    undocumentedCount: counts.undocumentedCount,
    coveredBySingleCount,
    coveredByMonthlyCount,
    uncoveredDocumentedCount,
    canCreateRecord: counts.undocumentedCount === 0 && counts.documentedCount > 0 && uncoveredDocumentedCount > 0,
    noShowAppointments: noShows,
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

  // Task #1496: Das Erstellen eines Leistungsnachweises ist nach Monatsabschluss
  // bewusst NICHT mehr gesperrt. Ein LN bewegt kein Budget/Geld (Verbrauch wird
  // bei der Dokumentation des Termins gebucht, nicht beim LN-Signieren), also
  // dürfen dokumentierte Termine auch nach dem 8. noch nachsigniert/abgerechnet
  // werden. Gesperrt bleibt nur das LÖSCHEN (Superadmin) und das Dokumentieren
  // selbst (separater Gate).

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

  // Task #1526: Wenn für diesen Kunden+Mitarbeiter+Monat bereits ein NICHT
  // unterschriebener (pending) Monats-LN existiert, werden die neu dokumentierten
  // Termine an diesen angehängt — statt einen zweiten pending-LN zu erzeugen.
  // employee_signed/completed = versiegelt (GoBD): dann ist ein NEUER LN für die
  // späteren Termine korrekt, der versiegelte wird nie mutiert.
  //
  // Der Lookup läuft INNERHALB der Transaktion mit `FOR UPDATE`-Sperre: so kann
  // zwischen „pending gefunden" und „Termine angehängt" keine parallele
  // Unterschrift den LN versiegeln (sonst würde ein GoBD-versiegelter LN mutiert).
  const ip = req.ip || req.socket.remoteAddress;

  const runCreateOrMerge = () => db.transaction(async (tx) => {
    const existingPending = await storage.getPendingMonthlyServiceRecord(customerId, effectiveEmployeeId, year, month, tx);

    if (existingPending) {
      await storage.addAppointmentsToServiceRecord(existingPending.id, appointmentIds, tx);
      await auditService.serviceRecordCreated(
        userId,
        existingPending.id,
        { customerId, year, month, appointmentCount: appointmentIds.length, mergedIntoPending: true },
        ip
      );
      return existingPending;
    }

    const rec = await storage.createServiceRecord({
      customerId,
      employeeId: effectiveEmployeeId,
      year,
      month,
      recordType: "monthly",
    }, tx);

    await storage.addAppointmentsToServiceRecord(rec.id, appointmentIds, tx);

    await auditService.serviceRecordCreated(
      userId,
      rec.id,
      { customerId, year, month, appointmentCount: appointmentIds.length },
      ip
    );

    return rec;
  });

  // Task #1528: Trifft ein gleichzeitiger Create ohne bestehenden pending-LN
  // ein, sehen beide „kein pending" und versuchen zu inserten. Der partielle
  // Unique-Index lässt nur EINEN gewinnen; der zweite läuft in 23505. Wir
  // wiederholen die Transaktion EINMAL — diesmal findet der FOR-UPDATE-Lookup
  // den inzwischen committeten pending-LN und merged korrekt hinein.
  let record;
  try {
    record = await runCreateOrMerge();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    record = await runCreateOrMerge();
  }

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
  
  const [appointment] = await appointmentsRepo.selectFrom()
    .where(and(
      eq(appointments.id, appointmentId),
      eq(appointments.customerId, customerId),
      appointmentsRepo.activeOnly()
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

  // appointment.date ist YYYY-MM-DD; parseLocalDate vermeidet UTC-Off-by-one
  // (z. B. Server in America/New_York wertet "2026-05-01" als 30.04. CET).
  const appointmentDate = parseLocalDate(appointment.date as string);
  const year = appointmentDate.getFullYear();
  const month = appointmentDate.getMonth() + 1;
  
  const appointmentEmployeeId = appointment.performedByEmployeeId || appointment.assignedEmployeeId || userId;

  // Task #1496: Einzel-Leistungsnachweis nach Monatsabschluss erlaubt (siehe oben).
  // Die Vorbedingung „Termin ist abgeschlossen (completed)" bleibt aktiv.

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

  const [appointment] = await appointmentsRepo.selectFrom()
    .where(and(eq(appointments.id, appointmentId), appointmentsRepo.activeOnly()))
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

  const linkedAppointments = await storage.getAppointmentsForServiceRecord(id);

  // Wer darf unterschreiben? Der dem Leistungsnachweis zugeordnete Mitarbeiter
  // (existingRecord.employeeId) ODER der Mitarbeiter, der einen der enthaltenen
  // Termine nachweislich geleistet hat (performedByEmployeeId) bzw. ihm zugewiesen
  // war (assignedEmployeeId — Vertretung/Backup). Admins immer.
  // Der Kunden-Zugriff ist oben bereits geprüft; hier wird die Eigentümer-Grenze
  // korrekt auf den tatsächlich Leistenden erweitert, ohne sie aufzuweichen — ein
  // fremder Mitarbeiter ohne Bezug zu den Terminen bleibt blockiert (Task #978).
  const allowedSignerIds = new Set<number>([existingRecord.employeeId]);
  for (const appt of linkedAppointments) {
    if (appt.performedByEmployeeId != null) allowedSignerIds.add(appt.performedByEmployeeId);
    if (appt.assignedEmployeeId != null) allowedSignerIds.add(appt.assignedEmployeeId);
  }
  if (!req.user!.isAdmin && !allowedSignerIds.has(req.user!.id)) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Nur der zugeordnete oder der ausführende Mitarbeiter darf diesen Leistungsnachweis unterschreiben",
    });
  }

  // Task #1496: Unterschreiben eines Leistungsnachweises ist nach Monatsabschluss
  // erlaubt — Signieren bewegt kein Budget/Geld. Die Vorbedingung, dass alle
  // verknüpften Termine im Status 'completed' sind, bleibt unten erhalten.

  const parsed = signServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Ungültige Eingabedaten",
      errors: parsed.error.errors 
    });
  }

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
    // Task #749 — Audit-Log für den Cache-Invalidierungs-Effekt (sichtbare
    // Folge: gespeicherte Leistungsnachweis-PDFs der laufenden Entwurfs-
    // Rechnungen werden beim nächsten Abruf neu gerendert).
    if (signerType === "customer") {
      console.log(
        `[service-records/sign] LN cache invalidated for customer=${record.customerId} period=${record.year}-${String(record.month).padStart(2, "0")} record=${record.id}`,
      );
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
    if (error instanceof Error && error.name === "EmptySignatureError") {
      return res.status(400).json({
        error: "EMPTY_SIGNATURE",
        message: error.message,
        code: (error as { code?: string }).code ?? "empty_canvas",
      });
    }
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

  const lockMsg = await ensureMonthOpenForRecord(
    { employeeId: record.employeeId, year: record.year, month: record.month },
    req.user!,
  );
  if (lockMsg) {
    return sendForbidden(res, "MONTH_CLOSED", lockMsg);
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
