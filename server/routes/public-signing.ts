import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { documentStorage } from "../storage/documents";
import { regeneratePdfWithSignature } from "../services/document-pdf";
import { createTask } from "../storage/tasks";
import { asyncHandler } from "../lib/errors";
import { computeDataHash } from "../services/signature-integrity";

const router = Router();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.get("/sign/:token", asyncHandler("Unterschrifts-Link konnte nicht geladen werden", async (req: Request, res: Response) => {
  const rawToken = req.params.token;
  const tokenHash = hashToken(rawToken);

  const tokenData = await documentStorage.getSigningTokenByHash(tokenHash);
  if (!tokenData) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dieser Unterschrifts-Link ist ungültig." });
    return;
  }

  if (tokenData.usedAt) {
    res.status(410).json({ error: "ALREADY_USED", message: "Dieses Dokument wurde bereits unterschrieben." });
    return;
  }

  if (new Date() > tokenData.expiresAt) {
    res.status(410).json({ error: "EXPIRED", message: "Dieser Unterschrifts-Link ist abgelaufen. Bitte wenden Sie sich an Ihren Arbeitgeber." });
    return;
  }

  const doc = tokenData.document;

  res.json({
    documentId: doc.id,
    fileName: doc.fileName,
    renderedHtml: doc.renderedHtml,
    customerSignatureData: doc.customerSignatureData,
    hasEmployerSignature: !!doc.customerSignatureData,
    generatedAt: doc.generatedAt,
    expiresAt: tokenData.expiresAt,
  });
}));

const signDocumentSchema = z.object({
  signatureData: z.string().min(1, "Unterschrift ist erforderlich"),
  signingLocation: z.string().nullable().optional(),
});

router.post("/sign/:token", asyncHandler("Unterschrift konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const rawToken = req.params.token;
  const tokenHash = hashToken(rawToken);

  const tokenData = await documentStorage.getSigningTokenByHash(tokenHash);
  if (!tokenData) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dieser Unterschrifts-Link ist ungültig." });
    return;
  }

  if (tokenData.usedAt) {
    res.status(410).json({ error: "ALREADY_USED", message: "Dieses Dokument wurde bereits unterschrieben." });
    return;
  }

  if (new Date() > tokenData.expiresAt) {
    res.status(410).json({ error: "EXPIRED", message: "Dieser Unterschrifts-Link ist abgelaufen." });
    return;
  }

  const parsed = signDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Unterschriftsdaten", details: parsed.error.issues });
    return;
  }

  const { signatureData, signingLocation } = parsed.data;
  const signingIp = req.ip || req.socket.remoteAddress || null;
  const doc = tokenData.document;

  const claimed = await documentStorage.markSigningTokenUsed(tokenData.id);
  if (!claimed) {
    res.status(410).json({ error: "ALREADY_USED", message: "Dieses Dokument wurde bereits unterschrieben." });
    return;
  }

  const { objectPath, fileName, integrityHash } = await regeneratePdfWithSignature(doc, signatureData, signingIp, signingLocation);

  await documentStorage.updateGeneratedDocumentAfterSigning(
    doc.id,
    signatureData,
    integrityHash,
    objectPath,
    fileName,
    signingIp,
    signingLocation,
  );

  if (doc.generatedByUserId) {
    const { users } = await import("@shared/schema");
    const { db } = await import("../lib/db");
    const { eq } = await import("drizzle-orm");

    let employeeName = "Ein Mitarbeiter";
    if (doc.employeeId) {
      const [emp] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, doc.employeeId)).limit(1);
      if (emp) employeeName = emp.displayName;
    }

    await createTask({
      title: `Dokument unterschrieben: ${doc.fileName}`,
      description: `${employeeName} hat das Dokument "${doc.fileName}" digital unterschrieben.`,
      priority: "medium",
      assignedToUserId: doc.generatedByUserId,
    }, doc.generatedByUserId);
  }

  res.json({
    success: true,
    message: "Dokument wurde erfolgreich unterschrieben. Vielen Dank!",
  });
}));

export default router;
