import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, canAccessCustomer } from "../middleware/auth";
import { insertServiceRecordSchema, insertSingleServiceRecordSchema, signServiceRecordSchema, serviceRecordAppointments, monthlyServiceRecords, appointments, NO_SHOW_REASON_LABELS, type NoShowReason } from "@shared/schema";
import { asyncHandler, sendForbidden, sendNotFound, sendConflict, sendBadRequest } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { authService } from "../services/auth";
import { auditService } from "../services/audit";
import { db } from "../lib/db";
import { hasActiveInvoiceForAppointments } from "../lib/appointment-invoiced";
import { reopenAppointmentForRedocumentation, type AppointmentReopenFacts } from "../lib/appointment-reopen";
import { isAdminLike } from "@shared/policies/appointments";
import { appointmentsRepo, monthlyServiceRecordsRepo } from "../repos";
import { eq, and, isNull, ne, inArray } from "drizzle-orm";
import { appointmentBelongsToEmployeeScope } from "@shared/domain/service-record-scope";
import { invalidateDraftInvoicePdfCache } from "../storage/service-records-storage";
import { parseLocalDate } from "@shared/utils/datetime";
import { timeTrackingStorage } from "../storage/time-tracking";

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
    } else if (item.documentedCount > 0) {
      // Task #1896 — alle eigenen dokumentierten Termine sind abgedeckt, aber
      // durch einen FREMDEN Nachweis (Altbestand aus der Stammkraft-Zeit).
      // Ohne diesen Zweig fiel der Fall auf "ready" — die Kachel bot einen
      // Nachweis an, den `canCreateRecord` im selben Objekt verweigert. Genau
      // die Phantom-Aufgabe, die #1896 abräumt.
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

  // Task #1896 — kein `isPrimary` mehr: alle sieben Leser liefern denselben,
  // eigenen Umfang. Vorher schaltete die Stammkraft-Ausnahme hier den
  // Mitarbeiter-Filter ab und der Dialog zeigte die Termine der Kollegen als
  // die eigenen an.
  const [existingRecord, counts, customerData, coveredBySingleCount, coveredByMonthlyCount, noShowAppointments, documentedAppointments] = await Promise.all([
    storage.getServiceRecordByPeriod(customerId, effectiveUserId, year, month),
    storage.getAppointmentCountsForPeriod(customerId, effectiveUserId, year, month),
    storage.getCustomer(customerId),
    storage.getCoveredBySingleCount(customerId, effectiveUserId, year, month),
    storage.getCoveredByMonthlyCount(customerId, effectiveUserId, year, month),
    storage.getNoShowAppointmentsForPeriod(customerId, effectiveUserId, year, month),
    storage.getDocumentedAppointmentsForPeriod(customerId, effectiveUserId, year, month),
  ]);

  const coveredCount = coveredBySingleCount + coveredByMonthlyCount;
  const uncoveredDocumentedCount = Math.max(0, counts.documentedCount - coveredCount);

  // Task #1542 — Für den On-Demand-Sammel-LN liefert der Endpoint die konkrete
  // Liste der noch nicht abgedeckten, dokumentierten Termine mit. Daraus baut
  // das Frontend die Auswahl (alle vorausgewählt, einzelne abwählbar), die als
  // `appointmentIds` an POST /service-records zurückgeht.
  const documentedApptIds = documentedAppointments.map((apt) => apt.id);
  const alreadyCoveredApptIds = await storage.getAppointmentIdsInServiceRecords(documentedApptIds);
  const selectableAppointments = documentedAppointments
    .filter((apt) => !alreadyCoveredApptIds.includes(apt.id))
    .map((apt) => ({
      id: apt.id,
      date: apt.date,
      scheduledStart: apt.scheduledStart,
      scheduledEnd: apt.scheduledEnd,
    }));

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
      waitMinutes: appt.noShowWaitMinutes ?? null,
      kilometers: appt.noShowKilometers ?? null,
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
    selectableAppointments,
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

  // `canAccessCustomer` beantwortet „darf sehen?" — notwendig, aber NICHT
  // hinreichend. Task #1896: welche Termine in den Nachweis dürfen, entscheidet
  // allein „gehören sie ihm?". Das erzwingen die Leser unten, die seit #1896
  // ausnahmslos auf den eigenen Umfang gefiltert sind
  // (`employeeServiceRecordScopeCondition`); der frühere `isPrimary`-Durchgriff,
  // über den die Stammkraft fremde Termine bündeln konnte, ist ersatzlos weg.
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

  const undocumentedAppointments = await storage.getUndocumentedAppointmentsForPeriod(customerId, effectiveEmployeeId, year, month);
  if (undocumentedAppointments.length > 0) {
    return res.status(400).json({ 
      message: `Es gibt noch ${undocumentedAppointments.length} nicht dokumentierte Termine in diesem Monat. Bitte dokumentieren Sie alle Termine, bevor Sie den Leistungsnachweis erstellen.`,
      undocumentedCount: undocumentedAppointments.length
    });
  }
  
  const documentedAppointments = await storage.getDocumentedAppointmentsForPeriod(customerId, effectiveEmployeeId, year, month);
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

  // Task #1542 — On-Demand-Sammel-LN: der Mitarbeiter entscheidet, WELCHE der
  // noch nicht abgedeckten, dokumentierten Termine gebündelt werden. Ohne
  // explizite Auswahl werden ALLE offenen dokumentierten Termine des Monats
  // vorgeschlagen (Default). Es entsteht IMMER genau EIN neuer Sammel-LN
  // (recordType='monthly') — KEIN Merge in einen bestehenden pending-LN mehr,
  // KEIN automatisch wachsender Monatscontainer. Mehrere Sammel-LN pro Monat
  // sind dadurch gewollt möglich (der Pending-Unique-Index aus #1528 wurde
  // entfernt).
  const remainingIds = new Set(remainingAppointments.map(apt => apt.id));
  let appointmentIds: number[];
  if (parsed.data.appointmentIds && parsed.data.appointmentIds.length > 0) {
    const requested = Array.from(new Set(parsed.data.appointmentIds));
    const invalid = requested.filter(id => !remainingIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({
        message:
          "Mindestens ein ausgewählter Termin ist nicht (mehr) verfügbar: er gehört nicht zu diesem Kunden/Monat, ist nicht dokumentiert oder bereits durch einen anderen Leistungsnachweis abgedeckt.",
        invalidAppointmentIds: invalid,
      });
    }
    appointmentIds = requested;
  } else {
    appointmentIds = remainingAppointments.map(apt => apt.id);
  }

  const ip = req.ip || req.socket.remoteAddress;

  // Task #1542 — Race-Safe Coverage-Ausschluss: die obige Prüfung
  // (getAppointmentIdsInServiceRecords) lief außerhalb der Transaktion. Ohne den
  // früheren Pending-Unique-Index könnten zwei gleichzeitige Creates denselben
  // Termin in zwei verschiedene Sammel-LN aufnehmen (Invariante „ein Termin liegt
  // in genau EINEM aktiven LN"). Deshalb werden die zu bündelnden Termin-Zeilen
  // innerhalb der Transaktion mit FOR UPDATE gesperrt und die Abdeckung erneut
  // geprüft; ein zwischenzeitlich abgedeckter Termin bricht mit 409 ab.
  let conflictingIds: number[] | null = null;
  const record = await db.transaction(async (tx) => {
    await storage.lockAppointmentsForUpdate(appointmentIds, tx);
    const nowCovered = await storage.getAppointmentIdsInServiceRecords(appointmentIds, tx);
    if (nowCovered.length > 0) {
      conflictingIds = nowCovered;
      return null;
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

  if (conflictingIds !== null) {
    return res.status(409).json({
      message:
        "Mindestens ein Termin wurde zeitgleich durch einen anderen Leistungsnachweis abgedeckt. Bitte laden Sie die Liste neu und wählen Sie erneut.",
      invalidAppointmentIds: conflictingIds,
    });
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

  // Task #1896 — „gehört er ihm?" statt „darf er ihn sehen?".
  //
  // Der Sammel-Pfad erzwingt den eigenen Umfang über die Leser (die liefern nur
  // eigene Termine). Dieser Pfad holt den Termin per ID und hatte deshalb gar
  // keine Eigentümer-Grenze: `canAccessCustomer` oben sagt für jede Stammkraft
  // ja, und damit konnte sie über den Termin eines KOLLEGEN einen
  // Leistungsnachweis anlegen — auf dessen Namen (`appointmentEmployeeId` unten
  // ist der Erbringer), aber ohne dessen Zutun. Genau das Dokument, das die
  // GoBD-Regel „Erbringer = Unterzeichner" verbietet.
  //
  // Admins bleiben ausgenommen (Büro legt für Mitarbeiter an) — die
  // Unterschrift bleibt ihnen davon unabhängig verwehrt, dafür sorgt
  // `allowedSignerIds` in `POST /:id/sign`.
  if (!req.user!.isAdmin && !appointmentBelongsToEmployeeScope(appointment, userId)) {
    return sendForbidden(
      res,
      "FORBIDDEN",
      "Sie können einen Leistungsnachweis nur für Ihre eigenen Termine erstellen.",
    );
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

  // Task #1542 — Race-Safe Coverage-Ausschluss (analog zum Sammel-LN): die obige
  // getServiceRecordForAppointment-Prüfung lief außerhalb der Transaktion. Innerhalb
  // der Transaktion wird die Termin-Zeile mit FOR UPDATE gesperrt und die globale
  // Abdeckung erneut geprüft, damit derselbe Termin nicht durch einen gleichzeitigen
  // Einzel- oder Sammel-LN doppelt belegt wird.
  let alreadyCovered = false;
  const record = await db.transaction(async (tx) => {
    await storage.lockAppointmentsForUpdate([appointmentId], tx);
    const nowCovered = await storage.getAppointmentIdsInServiceRecords([appointmentId], tx);
    if (nowCovered.length > 0) {
      alreadyCovered = true;
      return null;
    }

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

  if (alreadyCovered) {
    return res.status(409).json({
      message: "Für diesen Termin existiert bereits ein Leistungsnachweis.",
    });
  }

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

  // Wer darf unterschreiben? NUR der Mitarbeiter, auf den der Nachweis
  // ausgestellt ist — plus Admins.
  //
  // Task #1896 — ERSETZT die Erweiterung aus Task #978, die zusätzlich jeden
  // `performedByEmployeeId`/`assignedEmployeeId` der enthaltenen Termine
  // zuließ. Sie war nötig, solange ein Nachweis fremde Termine enthalten
  // konnte; seit der Umfang eines Nachweises auf die eigenen Termine begrenzt
  // ist (Leser + Anlege-Guards), ist der zugeordnete Mitarbeiter per
  // Konstruktion auch der Erbringer. Die Erweiterung ließe nur noch das zu, was
  // die GoBD-Regel „Erbringer = Unterzeichner" gerade verbietet: dass B
  // unterschreibt, was A geleistet hat.
  //
  // Abgesichert durch die Prod-Abfrage vom 08.08.2026
  // (`docs/p1-1896-performer-vs-assigned-exposure.sql`): `performed_by` und
  // `assigned` fallen in KEINEM Termin auseinander, die Verengung nimmt also
  // niemandem eine heute genutzte Unterschrift.
  //
  // Co-Visit (Zwei-Kräfte-Einsatz, #1613): jede Kraft hat ihren EIGENEN Termin
  // und damit ihren eigenen Nachweis — die Kante braucht die Erweiterung nicht.
  if (!req.user!.isAdmin && req.user!.id !== existingRecord.employeeId) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Nur der zugeordnete Mitarbeiter darf diesen Leistungsnachweis unterschreiben",
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
    // VOR der „kann nur"-Prüfung: der gelöschte Nachweis ist ein eigener
    // Zustand (409 Conflict), kein Eingabefehler (400). Die Reihenfolge ist
    // bedeutsam — die Meldung enthält bewusst NICHT „kann nur", würde aber bei
    // einer künftigen Umformulierung sonst in den falschen Zweig fallen.
    if (error instanceof Error && error.name === "ServiceRecordDeletedError") {
      return sendConflict(res, "RECORD_DELETED", error.message);
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

  const isInvoiced = await hasActiveInvoiceForAppointments(linkedAppointmentIds);

  res.json({ isInvoiced });
}));

router.delete("/:id", requireAuth, asyncHandler("Leistungsnachweis konnte nicht gelöscht werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const record = await storage.getServiceRecord(id);
  if (!record) {
    return sendNotFound(res, "Leistungsnachweis nicht gefunden.");
  }

  // Zugriff (entschieden 07.08.): Eigentümer für den eigenen Nachweis, Admin für
  // jeden — beides nur, solange nicht abgerechnet (Guard in der Tx unten).
  // `isAdminLike` statt `isAdmin`: ein Super-Admin ohne gesetztes `is_admin`
  // fiele sonst in den Eigentümer-Zweig und bekäme 403 auf fremde Nachweise.
  const isOwner = record.employeeId === req.user!.id;
  const adminLike = isAdminLike({
    id: req.user!.id,
    isAdmin: !!req.user!.isAdmin,
    isSuperAdmin: !!req.user!.isSuperAdmin,
    isTeamLead: !!req.user!.isTeamLead,
    isActive: !!req.user!.isActive,
  });
  if (!adminLike && !isOwner) {
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
  let reopened: AppointmentReopenFacts[];
  let recordStatus: string;
  try {
    ({ linkedAppointmentIds, reopened, recordStatus } = await db.transaction(async (tx) => {
    // SPERR-REIHENFOLGE: erst die TERMINE, dann die LN-Zeile.
    //
    // Das ist die Ordnung, die alle anderen Schreiber verwenden — der
    // LN-Create sperrt die Termine vor dem Anlegen, und der Termin-Löschpfad
    // tut es ebenfalls: `lockAndCheckAppointmentLocked` ruft als ERSTES
    // `lockAppointmentsForUpdate` und sperrt erst danach die LN-Zeilen.
    // Diese Route sperrte nach #70 umgekehrt (LN-Zeile zuerst, Termine implizit
    // beim UPDATE) und war damit gegen den Reopen-Pfad ein echtes ABBA. Sie
    // zieht jetzt nach.
    //
    // NICHT die letzte Inversion im Repo: der Co-Visit-Zweig des
    // Termin-Löschpfads sperrt Termin → LN → Partner-Termin, und die
    // Startup-Dedupe-Migration sperrt Junction vor LN-Zeile ganz ohne
    // Termin-Locks. Beides eigene Baustellen (FINDINGs im PR).
    //
    // `lockAppointmentsForUpdate` sortiert die IDs aufsteigend; damit sind auch
    // zwei gleichzeitige Korrekturen mit überlappenden Terminmengen
    // untereinander deadlock-frei.
    const preLinked = await tx.select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, id));
    const preIds = preLinked.map(r => r.appointmentId);
    await storage.lockAppointmentsForUpdate(preIds, tx);

    // Jetzt die LN-Zeile. Bewusst OHNE `activeOnly()`: wir müssen gerade
    // unterscheiden können, ob der Nachweis schon soft-gelöscht ist
    // (→ ALREADY_DELETED statt stillem Durchlauf), und dafür die Zeile
    // trotzdem sperren.
    const [locked] = await monthlyServiceRecordsRepo
      .selectColumnsFrom({
        deletedAt: monthlyServiceRecords.deletedAt,
        status: monthlyServiceRecords.status,
      }, tx)
      .where(eq(monthlyServiceRecords.id, id))
      .for("update");
    if (!locked || locked.deletedAt) {
      throw new Error("ALREADY_DELETED");
    }

    // Junction unter BEIDEN Locks autoritativ neu lesen und sicherstellen, dass
    // die Menge nicht GEWACHSEN ist. Der Guard trägt die Invariante, auf der
    // alles Weitere steht: `aptIds ⊆ preIds` — nur dann sind ALLE Termine, die
    // `reopenAppointmentForRedocumentation` gleich anfasst, auch gesperrt.
    //
    // REIN DEFENSIV, über die Anwendung nicht auslösbar: kein App-Pfad hängt
    // Termine an einen BESTEHENDEN Nachweis. Alle Aufrufer von
    // `addAppointmentsToServiceRecord` übergeben eine Record-ID, die in
    // derselben Transaktion gerade erst entstanden ist (beide LN-Create-Pfade,
    // Termin-Import). Erreichbar wären allenfalls die Startup-Dedupe-Migration
    // und ein liegengebliebenes Wartungsskript.
    //
    // Warum abbrechen und nicht nachsperren: nachträglich Termine zu sperren
    // hieße, NACH der LN-Zeile wieder Termine zu sperren — genau die Inversion,
    // die dieser Umbau beseitigt.
    const linkedAppointments = await tx.select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, id));
    const aptIds = linkedAppointments.map(r => r.appointmentId);
    const preSet = new Set(preIds);
    if (aptIds.some(x => !preSet.has(x))) {
      throw new Error("CONCURRENT_MODIFICATION");
    }

    if (await hasActiveInvoiceForAppointments(aptIds, tx)) {
      throw new Error("INVOICED");
    }

    await tx.delete(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, id));

    // ERSETZT das pauschale `UPDATE appointments SET status='documenting'`.
    // Das setzte nur den Status und ließ zwei Reste stehen: die Budget-Buchung
    // des alten Umfangs (bei einer Aufwärts-Korrektur bucht der erneute
    // Abschluss dann zusätzlich) und eine etwaige System-Signatur aus dem
    // Budget-Backfill (Task #876), die den Termin ohne jedes menschliche Zutun
    // weiter als „unterschrieben" gelten ließ. Beides erledigt die SSoT, die
    // auch `POST /api/appointments/:id/reopen` benutzt.
    //
    // Nur LEBENDE Termine: für soft-gelöschte Karteileichen gibt es nichts
    // zurückzudrehen. Der Rechnungs-Guard oben prüft bewusst ALLE verknüpften
    // Termine, auch die toten — eine alte aktive Rechnung blockiert weiterhin.
    const livingAppointments = aptIds.length > 0
      ? await appointmentsRepo
        .selectColumnsFrom({
          id: appointments.id,
          status: appointments.status,
          signatureData: appointments.signatureData,
        }, tx)
        .where(and(inArray(appointments.id, aptIds), appointmentsRepo.activeOnly()))
      : [];

    const facts: AppointmentReopenFacts[] = [];
    for (const appt of livingAppointments) {
      facts.push(await reopenAppointmentForRedocumentation(appt, req.user!.id, tx));
    }

    await tx.update(monthlyServiceRecords)
      .set({ deletedAt: new Date() })
      .where(eq(monthlyServiceRecords.id, id));

    // Wie beim Signieren und beim reduktions-only-Entfernen: der LN ist Anlage
    // zur Rechnung, sein Inhalt hat sich geändert. Hier sogar maximal — alle
    // Termine sind raus und der Nachweis ist weg. Ohne die Invalidierung
    // behielte ein Entwurf seinen gecachten `leistungsnachweisPath`.
    await invalidateDraftInvoicePdfCache(tx, {
      customerId: record.customerId,
      year: record.year,
      month: record.month,
    });

    return { linkedAppointmentIds: aptIds, reopened: facts, recordStatus: locked.status };
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "INVOICED") {
      return sendConflict(res, "INVOICED", "Dieser Leistungsnachweis kann nicht gelöscht werden, da Termine bereits abgerechnet wurden.");
    }
    if (error instanceof Error && error.message === "ALREADY_DELETED") {
      return sendConflict(res, "ALREADY_DELETED", "Dieser Leistungsnachweis wurde bereits gelöscht.");
    }
    if (error instanceof Error && error.message === "CONCURRENT_MODIFICATION") {
      return sendConflict(
        res,
        "CONCURRENT_MODIFICATION",
        "Der Leistungsnachweis wurde parallel verändert. Bitte erneut versuchen.",
      );
    }
    throw error;
  }

  const ip = req.ip || req.socket.remoteAddress;

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
      // Aus der GESPERRTEN Zeile, nicht aus dem Read davor: genau die
      // gleichzeitig committende Unterschrift, gegen die der Lock schuetzt,
      // machte den Wert hier sonst falsch.
      status: recordStatus,
      affectedAppointmentIds: linkedAppointmentIds,
      reopenedAppointmentIds: reopened.map((f) => f.appointmentId),
      deletedBy: req.user!.id,
    }
  );

  // Je zurückgegebenem Termin ein eigener Eintrag. Vorher stand die Korrektur
  // NUR am Nachweis; im Verlauf des Termins war der Rücksprung
  // `completed → documenting` gar nicht sichtbar und nur indirekt über
  // `affectedAppointmentIds` des LN-Eintrags rekonstruierbar. Dieselbe Aktion
  // wie beim Mitarbeiter-Reopen, unterschieden über `reason`.
  for (const facts of reopened) {
    await auditService.log(
      req.user!.id,
      "appointment_reopened",
      "appointment",
      facts.appointmentId,
      {
        customerId: record.customerId,
        previousStatus: facts.previousStatus,
        reversedTransactions: facts.reversedTransactions,
        hadSignature: facts.clearedDirectSignature,
        reason: "service_record_corrected",
        serviceRecordId: id,
      },
      ip
    );
  }

  res.json({ success: true, message: "Leistungsnachweis gelöscht. Die zugehörigen Termine stehen wieder zur Bearbeitung bereit." });
}));

export default router;
