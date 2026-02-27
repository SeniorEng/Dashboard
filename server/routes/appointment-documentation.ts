import { Router } from "express";
import { storage } from "../storage";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { documentKundenterminSchema } from "@shared/schema";
import { appointmentService } from "../services/appointments";
import { auditService } from "../services/audit";
import { computeDataHash } from "../services/signature-integrity";
import { asyncHandler, badRequest, notFound, forbidden, AppError, ErrorMessages } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { checkCustomerAccess } from "./appointments";

const router = Router();
router.use(requireAuth);

router.post("/:id/document", asyncHandler("Fehler beim Speichern der Dokumentation", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    throw badRequest(ErrorMessages.invalidAppointmentId);
  }

  const appointment = await storage.getAppointment(id);
  if (!appointment) {
    throw notFound(ErrorMessages.appointmentNotFound);
  }

  if (!await checkCustomerAccess(req.user!, appointment.customerId, res)) return;

  const isLocked = await storage.isAppointmentLocked(id);
  if (isLocked) {
    throw forbidden("APPOINTMENT_LOCKED", "Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.");
  }

  if (appointment.signatureData && req.body.signatureData) {
    throw forbidden("SIGNATURE_LOCKED", "Dieser Termin hat bereits eine gesperrte Unterschrift. Bitte wenden Sie sich an einen Administrator zur Stornierung.");
  }

  const validatedData = documentKundenterminSchema.parse(req.body);

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

  if (hasUsage) {
    try {
      budgetTransaction = await budgetLedgerStorage.createConsumptionTransaction({
        customerId: appointment.customerId,
        appointmentId: id,
        transactionDate: appointment.date,
        hauswirtschaftMinutes,
        alltagsbegleitungMinutes,
        travelKilometers,
        customerKilometers,
        userId: req.user?.id,
      });

      try {
        const summary = await budgetLedgerStorage.getBudgetSummary(appointment.customerId);
        if (summary.monthlyLimitCents !== null && summary.currentMonthUsedCents > summary.monthlyLimitCents) {
          const limitEuro = (summary.monthlyLimitCents / 100).toFixed(2);
          const usedEuro = (summary.currentMonthUsedCents / 100).toFixed(2);
          budgetWarning = `Hinweis: Das vereinbarte Monatslimit von ${limitEuro} € wurde überschritten (aktuell ${usedEuro} €).`;
        }
      } catch {
      }
    } catch (budgetError: unknown) {
      const errorMessage = budgetError instanceof Error ? budgetError.message : "Budget-Abbuchung fehlgeschlagen";
      if (errorMessage.includes("Preisvereinbarung")) {
        throw badRequest(`${errorMessage}. Bitte hinterlegen Sie zuerst eine Preisvereinbarung für diesen Kunden.`);
      }
      budgetWarning = errorMessage;
      console.warn("Budget booking warning:", budgetError);
    }
  }

  const updatedAppointment = await storage.updateAppointment(id, updateData);

  if (!updatedAppointment) {
    throw new AppError(500, "SERVER_ERROR", "Fehler beim Speichern der Dokumentation");
  }

  if (docResult.serviceUpdates && docResult.serviceUpdates.length > 0) {
    await storage.updateAppointmentServiceDocumentation(id, docResult.serviceUpdates);
  }

  const ip = req.ip || req.socket.remoteAddress;
  await auditService.documentationSubmitted(
    req.user!.id,
    id,
    { customerId: appointment.customerId, hasSignature, performedByEmployeeId: (updateData as Record<string, unknown>).performedByEmployeeId as number | null },
    ip
  );
  if (hasSignature) {
    const sigHash = (updateData as Record<string, unknown>).signatureHash as string;
    await auditService.signatureAdded(
      req.user!.id,
      id,
      { customerId: appointment.customerId, signatureHash: sigHash },
      ip
    );
  }

  res.json({
    ...updatedAppointment,
    budgetTransaction,
    budgetWarning,
  });
}));

export default router;
