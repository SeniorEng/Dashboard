import { Router } from "express";
import { storage } from "../storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { documentAppointmentSchema, documentNoShowSchema, customers as customersTable } from "@shared/schema";
import { appointmentService } from "../services/appointments";
import { auditService } from "../services/audit";
import { computeDataHash } from "../services/signature-integrity";
import { asyncHandler, badRequest, notFound, forbidden, AppError, ErrorMessages } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { requireAuth } from "../middleware/auth";
import { timeTrackingStorage } from "../storage/time-tracking";
import { db } from "../lib/db";
import { checkAndRecalcDailyAutoBreak } from "../services/auto-breaks";
import { canDocumentAppointment as policyCanDocument } from "@shared/policies/appointments";
import { toPolicyAppointment, toPolicyUser } from "./appointments";
import { formatEuroDE } from "@shared/utils/money";
import { computeNoShowCharge, type CancellationPolicyType } from "@shared/domain/cancellation-policy";
import { formatTimeHHMMSS } from "@shared/utils/datetime";
import { eq } from "drizzle-orm";
import { serviceCatalogStorage } from "../storage/service-catalog";

const router = Router();
router.use(requireAuth);

router.post("/:id/document", asyncHandler("Fehler beim Speichern der Dokumentation", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    throw notFound(ErrorMessages.appointmentNotFound);
  }

  // Doppelbuchungs-Schutz VOR der Policy: Wenn der Termin schon einmal
  // dokumentiert wurde (Status `completed` ODER eine Signatur liegt vor),
  // antworten wir mit dem dedizierten `ALREADY_COMPLETED`-Code, damit der
  // Client den Spezialfall sauber unterscheiden kann. Sonst würde
  // `policyCanDocument` einen abgeschlossenen Termin als nicht editierbar
  // einstufen und mit dem generischen `ACCESS_DENIED` antworten.
  if (appointment.status === "completed" || appointment.status === "customer_no_show" || appointment.signatureData) {
    throw forbidden("ALREADY_COMPLETED", "Dieser Termin wurde bereits dokumentiert");
  }

  // Zentrale Policy: Lock, Monatsabschluss, Rolle/Zuweisung, Status — alles
  // wird in shared/policies/appointments.ts entschieden.
  const isLocked = await storage.isAppointmentLocked(id);
  let isMonthClosed = false;
  const employeeIdForMonth = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
  if (employeeIdForMonth && appointment.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeIdForMonth, appointment.date);
  }
  const decision = policyCanDocument(
    toPolicyUser(req.user!),
    toPolicyAppointment(appointment, { isLocked, isMonthClosed }),
  );
  if (!decision.allowed) {
    if (isLocked) {
      throw forbidden("APPOINTMENT_LOCKED", decision.reason);
    }
    if (isMonthClosed) {
      throw forbidden("MONTH_CLOSED", decision.reason);
    }
    throw forbidden("ACCESS_DENIED", decision.reason);
  }

  if (appointment.signatureData && req.body.signatureData) {
    throw forbidden("SIGNATURE_LOCKED", "Dieser Termin hat bereits eine gesperrte Unterschrift. Bitte wenden Sie sich an einen Administrator zur Stornierung.");
  }

  const validatedData = documentAppointmentSchema.parse(req.body);

  const docServiceIds = validatedData.services.map(s => s.serviceId);
  const validServices = await storage.getServicesByIds(docServiceIds);
  if (validServices.length !== docServiceIds.length) {
    const validIds = new Set(validServices.map(s => s.id));
    const invalidIds = docServiceIds.filter(sid => !validIds.has(sid));
    throw badRequest(`Ungültige Service-IDs: ${invalidIds.join(', ')}`);
  }

  const serviceInfoMap = Object.fromEntries(validServices.map(s => [s.id, { code: s.code }]));
  const enrichedData = {
    ...validatedData,
    services: validatedData.services.map(s => ({
      ...s,
      serviceCode: serviceInfoMap[s.serviceId]?.code || null,
    })),
  };

  const validation = appointmentService.validateDocumentationInput(appointment, enrichedData);
  if (!validation.valid) {
    if (validation.error === "ALREADY_COMPLETED") {
      throw forbidden(validation.error, validation.message!);
    }
    throw badRequest(validation.message!);
  }

  const docResult = appointmentService.buildDocumentationUpdate(appointment, enrichedData, req.user?.id);
  const { updateData, hauswirtschaftMinutes, alltagsbegleitungMinutes, travelKilometers, customerKilometers, hasUsage } = docResult;

  const hasSignature = !!(updateData as Record<string, unknown>).signatureData;
  if (hasSignature) {
    const sigData = (updateData as Record<string, unknown>).signatureData as string;
    (updateData as Record<string, unknown>).signatureHash = computeDataHash(sigData);
    (updateData as Record<string, unknown>).signedAt = new Date();
    (updateData as Record<string, unknown>).signedByUserId = req.user!.id;
  }

  let budgetTransaction = null;
  let budgetWarning: string | null = null;

  const updatedAppointment = await db.transaction(async (tx) => {
    const result = await storage.updateAppointment(id, updateData, tx);
    if (!result) {
      throw new AppError(500, "SERVER_ERROR", "Fehler beim Speichern der Dokumentation");
    }

    if (docResult.serviceUpdates && docResult.serviceUpdates.length > 0) {
      await storage.updateAppointmentServiceDocumentation(id, docResult.serviceUpdates, tx);
    }

    if (hasUsage && appointment.appointmentType !== "Erstberatung") {
      try {
        budgetTransaction = await budgetLedgerStorage.createConsumptionTransaction({
          customerId: appointment.customerId!,
          appointmentId: id,
          transactionDate: appointment.date,
          hauswirtschaftMinutes,
          alltagsbegleitungMinutes,
          travelKilometers,
          customerKilometers,
          userId: req.user?.id,
        }, tx);

        try {
          const summary = await budgetLedgerStorage.getBudgetSummary(appointment.customerId!);
          if (summary.monthlyLimitCents !== null && summary.currentMonthUsedCents > summary.monthlyLimitCents) {
            const overEuro = formatEuroDE(summary.currentMonthUsedCents - summary.monthlyLimitCents);
            budgetWarning = `Monatslimit überschritten — ${overEuro} über dem Limit.`;
          }
        } catch (warnErr) {
          console.warn("[appointment-documentation] Budget-Limit-Prüfung fehlgeschlagen:", warnErr);
        }
      } catch (budgetError: unknown) {
        const errorMessage = budgetError instanceof Error ? budgetError.message : "Budget-Abbuchung fehlgeschlagen";
        if (errorMessage.includes("Preisvereinbarung") || errorMessage.includes("Budget reicht nicht")) {
          throw budgetError;
        }
        budgetWarning = errorMessage;
        console.warn("Budget booking warning:", budgetError);
      }
    }

    const ip = req.ip || req.socket.remoteAddress;
    await auditService.documentationSubmitted(
      req.user!.id,
      id,
      { customerId: appointment.customerId!, hasSignature, performedByEmployeeId: (updateData as Record<string, unknown>).performedByEmployeeId as number | null },
      ip
    );
    if (hasSignature) {
      const sigHash = (updateData as Record<string, unknown>).signatureHash as string;
      await auditService.signatureAdded(
        req.user!.id,
        id,
        { customerId: appointment.customerId!, signatureHash: sigHash },
        ip
      );
    }

    return result;
  }).catch((err) => {
    if (err instanceof AppError) throw err;
    const errorMessage = err instanceof Error ? err.message : "Budget-Abbuchung fehlgeschlagen";
    if (errorMessage.includes("Preisvereinbarung")) {
      throw badRequest(`${errorMessage}. Bitte hinterlegen Sie zuerst eine Preisvereinbarung für diesen Kunden.`);
    }
    if (errorMessage.includes("Budget reicht nicht")) {
      throw badRequest(errorMessage);
    }
    throw err;
  });

  if (appointment.date) {
    const employeeId = updatedAppointment?.performedByEmployeeId || appointment.assignedEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }

  if (appointment.prospectId && appointment.appointmentType === "Erstberatung") {
    try {
      const { prospectStorage } = await import("../storage/prospects");
      const prospect = await prospectStorage.getById(appointment.prospectId);
      if (prospect && prospect.status === "erstberatung_vereinbart") {
        await prospectStorage.update(appointment.prospectId, { status: "erstberatung_durchgeführt" });
        await prospectStorage.addNote({
          prospectId: appointment.prospectId,
          userId: req.user?.id,
          noteText: "Status geändert: erstberatung_vereinbart → erstberatung_durchgeführt (automatisch nach Dokumentation)",
          noteType: "statuswechsel",
        });
      }
    } catch (err) {
      console.warn("[appointment-documentation] Auto-Statuswechsel für Prospect fehlgeschlagen:", err);
    }
  }

  res.json({
    ...updatedAppointment,
    budgetTransaction,
    budgetWarning,
  });
}));

// ============================================
// CUSTOMER NO-SHOW DOCUMENTATION (Task #485)
// ============================================
// Sub-Flow: Kunde nicht angetroffen / verstorben / abgesagt.
//  - MA wird voll bezahlt (Status `customer_no_show`, MA-Lohn ergibt sich aus
//    geplanter Dauer; siehe Lohnart `leerfahrt` im Service-Katalog).
//  - §45b / Pflegekasse-Budget wird NICHT verbraucht (kein
//    `createConsumptionTransaction`-Aufruf).
//  - Wenn der Kunde eine Cancellation-Policy hat (≠ "none"), wird der
//    private Charge berechnet und im Audit-Log dokumentiert. Die tatsächliche
//    Privatrechnung erstellt der Billing-Flow später (siehe
//    `server/routes/billing.ts`).
router.get("/:id/no-show-preview", asyncHandler("Fehler bei der Vorschau-Berechnung", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment || !appointment.customerId) {
    throw notFound(ErrorMessages.appointmentNotFound);
  }

  // Authorization: gleiche Regel wie die spätere Buchung (POST /:id/document-no-show).
  // Verhindert IDOR-Probing fremder Termine zur Offenlegung kundenseitiger
  // Cancellation-Policy-Werte über die Vorschau.
  const isLocked = await storage.isAppointmentLocked(id);
  let isMonthClosed = false;
  const empForMonth = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
  if (empForMonth && appointment.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(empForMonth, appointment.date);
  }
  const previewDecision = policyCanDocument(
    toPolicyUser(req.user!),
    toPolicyAppointment(appointment, { isLocked, isMonthClosed }),
  );
  if (!previewDecision.allowed) {
    throw forbidden("ACCESS_DENIED", previewDecision.reason);
  }

  const km = Number(req.query.travelKilometers ?? 0);
  const waitMinutes = Number(req.query.waitMinutes ?? 0);

  const [customer] = await db
    .select({
      cancellationPolicyType: customersTable.cancellationPolicyType,
      cancellationFlatCents: customersTable.cancellationFlatCents,
      cancellationHourlyRateCents: customersTable.cancellationHourlyRateCents,
      cancellationKmRateCents: customersTable.cancellationKmRateCents,
      billingType: customersTable.billingType,
    })
    .from(customersTable)
    .where(eq(customersTable.id, appointment.customerId))
    .limit(1);

  const [travelKmSvc, hwSvc] = await Promise.all([
    serviceCatalogStorage.getServiceByCode("travel_km"),
    serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
  ]);

  const policyType = (customer?.cancellationPolicyType ?? "none") as CancellationPolicyType;
  const charge = computeNoShowCharge(
    {
      type: policyType,
      flatCents: customer?.cancellationFlatCents ?? null,
      hourlyRateCents: customer?.cancellationHourlyRateCents ?? null,
      kmRateCents: customer?.cancellationKmRateCents ?? null,
    },
    { travelKilometers: Number.isFinite(km) ? km : 0, waitMinutes: Number.isFinite(waitMinutes) ? waitMinutes : 0 },
    {
      kmRateCents: travelKmSvc?.defaultPriceCents ?? null,
      hourlyRateCents: hwSvc?.defaultPriceCents ?? null,
    },
  );

  res.json({
    policyType,
    billingType: customer?.billingType ?? null,
    chargeable: policyType !== "none" && (customer?.billingType === "selbstzahler"),
    charge,
  });
}));

router.post("/:id/document-no-show", asyncHandler("Fehler beim Speichern der Vergeblichen Anfahrt", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    throw notFound(ErrorMessages.appointmentNotFound);
  }
  if (!appointment.customerId) {
    throw badRequest("Kunden-No-Show ist nur für Kundentermine möglich (Erstberatungen ohne Kunde sind ausgeschlossen).");
  }
  if (appointment.status === "completed" || appointment.status === "customer_no_show" || appointment.signatureData) {
    throw forbidden("ALREADY_COMPLETED", "Dieser Termin wurde bereits dokumentiert");
  }

  const isLocked = await storage.isAppointmentLocked(id);
  let isMonthClosed = false;
  const employeeIdForMonth = appointment.assignedEmployeeId || appointment.performedByEmployeeId;
  if (employeeIdForMonth && appointment.date) {
    isMonthClosed = await timeTrackingStorage.isMonthClosed(employeeIdForMonth, appointment.date);
  }
  const decision = policyCanDocument(
    toPolicyUser(req.user!),
    toPolicyAppointment(appointment, { isLocked, isMonthClosed }),
  );
  if (!decision.allowed) {
    if (isLocked) throw forbidden("APPOINTMENT_LOCKED", decision.reason);
    if (isMonthClosed) throw forbidden("MONTH_CLOSED", decision.reason);
    throw forbidden("ACCESS_DENIED", decision.reason);
  }

  const validated = documentNoShowSchema.parse(req.body);

  // Kundenspezifische Cancellation-Policy laden (für Vorschau & Audit).
  const [customer] = await db
    .select({
      cancellationPolicyType: customersTable.cancellationPolicyType,
      cancellationFlatCents: customersTable.cancellationFlatCents,
      cancellationHourlyRateCents: customersTable.cancellationHourlyRateCents,
      cancellationKmRateCents: customersTable.cancellationKmRateCents,
      billingType: customersTable.billingType,
    })
    .from(customersTable)
    .where(eq(customersTable.id, appointment.customerId))
    .limit(1);

  // Fallback-Sätze aus dem Service-Katalog: travel_km für km-Satz,
  // hauswirtschaft für Stunden-Satz (Wartezeit wird wie HW-Stunde bewertet).
  const [travelKmSvc, hwSvc] = await Promise.all([
    serviceCatalogStorage.getServiceByCode("travel_km"),
    serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
  ]);

  const policyType = (customer?.cancellationPolicyType ?? "none") as CancellationPolicyType;
  const charge = computeNoShowCharge(
    {
      type: policyType,
      flatCents: customer?.cancellationFlatCents ?? null,
      hourlyRateCents: customer?.cancellationHourlyRateCents ?? null,
      kmRateCents: customer?.cancellationKmRateCents ?? null,
    },
    {
      travelKilometers: validated.travelKilometers,
      waitMinutes: validated.noShowWaitMinutes,
    },
    {
      kmRateCents: travelKmSvc?.defaultPriceCents ?? null,
      hourlyRateCents: hwSvc?.defaultPriceCents ?? null,
    },
  );

  const performedBy = validated.performedByEmployeeId ?? appointment.assignedEmployeeId ?? req.user?.id ?? null;
  const actualStartTime = formatTimeHHMMSS(validated.actualStart);

  const updateData: Record<string, unknown> = {
    performedByEmployeeId: performedBy,
    actualStart: actualStartTime,
    // actualEnd absichtlich NULL — der MA war zwar vor Ort, hat aber keine
    // Leistung erbracht. So bleibt die Auswertung "Leerfahrten" sauber
    // separierbar von echten Terminen.
    travelOriginType: validated.travelOriginType,
    travelFromAppointmentId: validated.travelFromAppointmentId ?? null,
    travelKilometers: validated.travelKilometers,
    travelMinutes: validated.travelMinutes ?? null,
    noShowReason: validated.noShowReason,
    noShowReasonText: validated.noShowReasonText ?? null,
    noShowWaitMinutes: validated.noShowWaitMinutes,
    noShowKilometers: validated.travelKilometers,
    noShowNotes: validated.noShowNotes ?? null,
    noShowChargeSuppressed: validated.noShowChargeSuppressed,
    noShowChargeSuppressionReason: validated.noShowChargeSuppressed
      ? validated.noShowChargeSuppressionReason!.trim()
      : null,
    status: "customer_no_show" as const,
  };

  const updatedAppointment = await db.transaction(async (tx) => {
    const result = await storage.updateAppointment(id, updateData, tx);
    if (!result) {
      throw new AppError(500, "SERVER_ERROR", "Fehler beim Speichern der Vergeblichen Anfahrt");
    }

    const ip = req.ip || req.socket.remoteAddress;
    await auditService.appointmentNoShowDocumented(
      req.user!.id,
      id,
      {
        customerId: appointment.customerId!,
        reason: validated.noShowReason,
        reasonText: validated.noShowReasonText ?? null,
        waitMinutes: validated.noShowWaitMinutes,
        kilometers: validated.travelKilometers,
        chargeCents: validated.noShowChargeSuppressed ? 0 : charge.totalCents,
        chargeSuppressed: validated.noShowChargeSuppressed,
        chargeSuppressionReason: validated.noShowChargeSuppressed
          ? validated.noShowChargeSuppressionReason!.trim()
          : null,
        policyType,
        performedByEmployeeId: performedBy,
      },
      ip,
      tx,
    );

    return result;
  });

  if (appointment.date) {
    const employeeId = performedBy || appointment.assignedEmployeeId;
    if (employeeId) {
      checkAndRecalcDailyAutoBreak(employeeId, appointment.date);
    }
  }

  res.json({
    ...updatedAppointment,
    noShowCharge: {
      totalCents: charge.totalCents,
      travelCents: charge.travelCents,
      waitCents: charge.waitCents,
      flatCents: charge.flatCents,
      description: charge.description,
      policyType,
      billable: charge.totalCents > 0,
    },
  });
}));

export default router;
