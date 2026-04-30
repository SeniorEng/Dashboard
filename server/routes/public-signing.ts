import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { users } from "@shared/schema";
import { documentStorage } from "../storage/documents";
import { regeneratePdfWithSignature } from "../services/document-pdf";
import { createTask } from "../storage/tasks";
import { asyncHandler } from "../lib/errors";
import { computeDataHash } from "../services/signature-integrity";
import { db } from "../lib/db";

const router = Router();

// Public signing routes are unauthenticated and trigger expensive PDF re-rendering.
// Limit per-IP request rate to prevent DoS via repeated calls.
const publicSigningLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED", message: "Zu viele Anfragen, bitte später erneut versuchen." },
});

router.use(publicSigningLimiter);

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function validateSigningToken(req: Request, res: Response): Promise<NonNullable<Awaited<ReturnType<typeof documentStorage.getSigningTokenByHash>>> | null> {
  const rawToken = req.params.token;
  const tokenHash = hashToken(rawToken);

  const tokenData = await documentStorage.getSigningTokenByHash(tokenHash);
  if (!tokenData) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dieser Unterschrifts-Link ist ungültig." });
    return null;
  }

  if (tokenData.usedAt) {
    res.status(410).json({ error: "ALREADY_USED", message: "Dieses Dokument wurde bereits unterschrieben." });
    return null;
  }

  if (new Date() > tokenData.expiresAt) {
    res.status(410).json({ error: "EXPIRED", message: "Dieser Unterschrifts-Link ist abgelaufen. Bitte wenden Sie sich an Ihren Arbeitgeber." });
    return null;
  }

  return tokenData;
}

router.get("/sign/:token", asyncHandler("Unterschrifts-Link konnte nicht geladen werden", async (req: Request, res: Response) => {
  const tokenData = await validateSigningToken(req, res);
  if (!tokenData) return;

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

const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

const signDocumentSchema = z.object({
  signatureData: z
    .string()
    .min(1, "Unterschrift ist erforderlich")
    .max(MAX_SIGNATURE_BYTES, "Unterschriftsbild ist zu groß (max. 2 MB)")
    .refine(
      (val) => SIGNATURE_DATA_URL_RE.test(val),
      "Unterschriftsdaten müssen ein base64-kodiertes PNG-, JPEG- oder WebP-Bild sein"
    ),
  signingLocation: z.string().nullable().optional(),
});

router.post("/sign/:token", asyncHandler("Unterschrift konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const tokenData = await validateSigningToken(req, res);
  if (!tokenData) return;

  const parsed = signDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Unterschriftsdaten", details: parsed.error.issues });
    return;
  }

  const { signatureData, signingLocation } = parsed.data;
  const signingIp = req.ip || req.socket.remoteAddress || null;
  const doc = tokenData.document;

  // PDF regeneration is slow (multi-second I/O) and must NOT happen inside a DB transaction.
  // We pre-resolve the employee display name needed for the follow-up task before opening the tx.
  const { objectPath, fileName, integrityHash } = await regeneratePdfWithSignature(doc, signatureData, signingIp, signingLocation);

  let employeeName = "Ein Mitarbeiter";
  if (doc.generatedByUserId && doc.employeeId) {
    const [emp] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, doc.employeeId)).limit(1);
    if (emp) employeeName = emp.displayName;
  }

  // Atomic: token-claim, document-state-update and follow-up task all succeed together,
  // or none of them are persisted. PDF regeneration above is idempotent enough that an
  // orphaned object in storage on rare rollback is acceptable.
  type TxOutcome =
    | { kind: "ok" }
    | { kind: "already_used" }
    | { kind: "already_signed" };

  const outcome: TxOutcome = await db.transaction(async (tx) => {
    const claimed = await documentStorage.markSigningTokenUsed(tokenData.id, tx);
    if (!claimed) return { kind: "already_used" } as const;

    const updated = await documentStorage.updateGeneratedDocumentAfterSigning(
      doc.id,
      signatureData,
      integrityHash,
      objectPath,
      fileName,
      signingIp,
      signingLocation,
      tx,
    );
    if (!updated) {
      throw new Error("__ROLLBACK_ALREADY_SIGNED__");
    }

    if (doc.generatedByUserId) {
      await createTask({
        title: `Dokument unterschrieben: ${doc.fileName}`,
        description: `${employeeName} hat das Dokument "${doc.fileName}" digital unterschrieben.`,
        priority: "medium",
        assignedToUserId: doc.generatedByUserId,
      }, doc.generatedByUserId, tx);
    }

    return { kind: "ok" } as const;
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message === "__ROLLBACK_ALREADY_SIGNED__") {
      return { kind: "already_signed" } as const;
    }
    throw err;
  });

  if (outcome.kind === "already_used") {
    res.status(410).json({ error: "ALREADY_USED", message: "Dieses Dokument wurde bereits unterschrieben." });
    return;
  }
  if (outcome.kind === "already_signed") {
    res.status(409).json({
      error: "ALREADY_SIGNED",
      message: "Dieses Dokument wurde zwischenzeitlich bereits unterschrieben.",
    });
    return;
  }

  res.json({
    success: true,
    message: "Dokument wurde erfolgreich unterschrieben. Vielen Dank!",
  });
}));

export default router;
