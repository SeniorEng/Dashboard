import { Router } from "express";
import { storage } from "../storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { documentAppointmentSchema } from "@shared/schema";
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

const router = Router();
router.use(requireAuth);

router.post("/:id/document", asyncHandler("Fehler beim Speichern der Dokumentation", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    throw notFound(ErrorMessages.appointmentNotFound);
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
            const overEuro = ((summary.currentMonthUsedCents - summary.monthlyLimitCents) / 100).toFixed(2).replace(".", ",");
            budgetWarning = `Monatslimit überschritten — ${overEuro} € über dem Limit.`;
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

export default router;
