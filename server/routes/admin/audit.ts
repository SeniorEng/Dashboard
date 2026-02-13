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

export default router;
