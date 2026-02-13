import { Router } from "express";
import { asyncHandler, notFound, badRequest } from "../../lib/errors";
import { auditService } from "../../services/audit";
import { auditLogFilterSchema } from "@shared/schema";
import { storage } from "../../storage";
import { computeDataHash } from "../../services/signature-integrity";

const router = Router();

router.get("/audit-log", asyncHandler("Audit-Log konnte nicht geladen werden", async (req, res) => {
  const filter = auditLogFilterSchema.parse({
    entityType: req.query.entityType || undefined,
    entityId: req.query.entityId ? parseInt(req.query.entityId as string) : undefined,
    userId: req.query.userId ? parseInt(req.query.userId as string) : undefined,
    action: req.query.action || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
    offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
  });

  const result = await auditService.getEntries(filter);
  res.json(result);
}));

router.get("/verify-signature/:entityType/:entityId", asyncHandler("Integritätsprüfung fehlgeschlagen", async (req, res) => {
  const { entityType, entityId: entityIdStr } = req.params;
  const entityId = parseInt(entityIdStr);
  const signerType = req.query.signerType as string | undefined;

  if (isNaN(entityId)) throw badRequest("Ungültige Entity-ID");

  if (entityType === "appointment") {
    const appointment = await storage.getAppointment(entityId);
    if (!appointment) throw notFound("Termin nicht gefunden");

    if (!appointment.signatureData || !appointment.signatureHash) {
      return res.json({ valid: false, reason: "no_signature", message: "Keine Unterschrift vorhanden" });
    }

    const currentHash = computeDataHash(appointment.signatureData);
    const isValid = currentHash === appointment.signatureHash;

    return res.json({
      valid: isValid,
      signedAt: appointment.signedAt,
      signedByUserId: appointment.signedByUserId,
      storedHash: appointment.signatureHash,
      computedHash: currentHash,
      message: isValid ? "Unterschrift ist unverändert" : "WARNUNG: Unterschrift wurde nach dem Signieren verändert!",
    });
  }

  if (entityType === "service_record") {
    const record = await storage.getServiceRecord(entityId);
    if (!record) throw notFound("Leistungsnachweis nicht gefunden");

    const results: Array<{
      signerType: string;
      valid: boolean;
      signedAt: Date | null;
      signedByUserId: number | null;
      message: string;
    }> = [];

    if (signerType === "employee" || !signerType) {
      if (record.employeeSignatureData && record.employeeSignatureHash) {
        const currentHash = computeDataHash(record.employeeSignatureData);
        const isValid = currentHash === record.employeeSignatureHash;
        results.push({
          signerType: "employee",
          valid: isValid,
          signedAt: record.employeeSignedAt,
          signedByUserId: record.employeeSignedByUserId ?? null,
          message: isValid ? "Mitarbeiter-Unterschrift ist unverändert" : "WARNUNG: Mitarbeiter-Unterschrift wurde verändert!",
        });
      } else {
        results.push({
          signerType: "employee",
          valid: false,
          signedAt: null,
          signedByUserId: null,
          message: "Keine Mitarbeiter-Unterschrift vorhanden",
        });
      }
    }

    if (signerType === "customer" || !signerType) {
      if (record.customerSignatureData && record.customerSignatureHash) {
        const currentHash = computeDataHash(record.customerSignatureData);
        const isValid = currentHash === record.customerSignatureHash;
        results.push({
          signerType: "customer",
          valid: isValid,
          signedAt: record.customerSignedAt,
          signedByUserId: record.customerSignedByUserId ?? null,
          message: isValid ? "Kunden-Unterschrift ist unverändert" : "WARNUNG: Kunden-Unterschrift wurde verändert!",
        });
      } else {
        results.push({
          signerType: "customer",
          valid: false,
          signedAt: null,
          signedByUserId: null,
          message: "Keine Kunden-Unterschrift vorhanden",
        });
      }
    }

    return res.json({ signatures: results });
  }

  throw badRequest("Ungültiger Entity-Typ. Erlaubt: appointment, service_record");
}));

router.post("/revoke-signature/:entityType/:entityId", asyncHandler("Stornierung fehlgeschlagen", async (req, res) => {
  const { entityType, entityId: entityIdStr } = req.params;
  const entityId = parseInt(entityIdStr);
  const { reason, signerType } = req.body;

  if (isNaN(entityId)) throw badRequest("Ungültige Entity-ID");
  if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
    throw badRequest("Ein Stornierungsgrund mit mindestens 3 Zeichen ist erforderlich.");
  }
  if (reason.trim().length > 500) {
    throw badRequest("Der Stornierungsgrund darf maximal 500 Zeichen lang sein.");
  }

  const ip = req.ip || req.socket.remoteAddress;
  const userId = (req as any).user!.id;

  if (entityType === "appointment") {
    const appointment = await storage.getAppointment(entityId);
    if (!appointment) throw notFound("Termin nicht gefunden");

    if (!appointment.signatureData) {
      throw badRequest("Dieser Termin hat keine Unterschrift zum Stornieren.");
    }

    const isLocked = await storage.isAppointmentLocked(entityId);
    if (isLocked) {
      throw badRequest("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises. Bitte stornieren Sie zuerst den Leistungsnachweis.");
    }

    await storage.updateAppointment(entityId, {
      signatureData: null,
      signatureHash: null,
      signedAt: null,
      signedByUserId: null,
      status: "documenting",
    } as any);

    await auditService.appointmentRevoked(
      userId,
      entityId,
      { customerId: appointment.customerId, reason, previousStatus: appointment.status },
      ip
    );

    return res.json({ success: true, message: "Unterschrift wurde storniert. Der Termin kann neu dokumentiert werden." });
  }

  if (entityType === "service_record") {
    const record = await storage.getServiceRecord(entityId);
    if (!record) throw notFound("Leistungsnachweis nicht gefunden");

    if (!signerType || !["employee", "customer"].includes(signerType)) {
      throw badRequest("signerType muss 'employee' oder 'customer' sein.");
    }

    const previousStatus = record.status;
    let updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (signerType === "customer") {
      if (!record.customerSignatureData) {
        throw badRequest("Keine Kunden-Unterschrift zum Stornieren vorhanden.");
      }
      updateData = {
        ...updateData,
        customerSignatureData: null,
        customerSignatureHash: null,
        customerSignedAt: null,
        customerSignedByUserId: null,
        status: "employee_signed",
      };
    } else {
      if (!record.employeeSignatureData) {
        throw badRequest("Keine Mitarbeiter-Unterschrift zum Stornieren vorhanden.");
      }
      updateData = {
        ...updateData,
        employeeSignatureData: null,
        employeeSignatureHash: null,
        employeeSignedAt: null,
        employeeSignedByUserId: null,
        customerSignatureData: null,
        customerSignatureHash: null,
        customerSignedAt: null,
        customerSignedByUserId: null,
        status: "pending",
      };
    }

    await storage.updateServiceRecord(entityId, updateData);

    await auditService.serviceRecordRevoked(
      userId,
      entityId,
      { customerId: record.customerId, reason, previousStatus, signerType },
      ip
    );

    return res.json({ success: true, message: `Unterschrift(en) wurden storniert. Status: ${updateData.status}` });
  }

  throw badRequest("Ungültiger Entity-Typ. Erlaubt: appointment, service_record");
}));

export default router;
