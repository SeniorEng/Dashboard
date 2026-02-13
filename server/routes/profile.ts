import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { authService } from "../services/auth";
import { documentStorage } from "../storage/documents";
import { usersCache, birthdaysCache } from "../services/cache";

const router = Router();

router.use(requireAuth);

const updateProfileSchema = z.object({
  telefon: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  email: z.string().email("Ungültige E-Mail-Adresse").optional(),
  haustierAkzeptiert: z.boolean().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTelefon: z.string().optional(),
  notfallkontaktBeziehung: z.string().optional(),
});

router.get("/", asyncHandler("Profil konnte nicht geladen werden", async (req: Request, res: Response) => {
  const user = req.user!;
  const { passwordHash, ...safeUser } = user;
  const roles = await authService.getUserRoles(user.id);
  res.json({ ...safeUser, roles });
}));

router.patch("/", asyncHandler("Profil konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const result = updateProfileSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  let updatedUser;
  try {
    updatedUser = await authService.updateUser(req.user!.id, result.data);
  } catch (error) {
    if (error instanceof Error && error.message.includes("bereits verwendet")) {
      res.status(409).json({
        error: "CONFLICT",
        message: error.message,
      });
      return;
    }
    throw error;
  }

  if (!updatedUser) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Benutzer nicht gefunden",
    });
    return;
  }

  usersCache.invalidateAll();
  birthdaysCache.invalidateAll();

  const { passwordHash, ...safeUser } = updatedUser;
  res.json(safeUser);
}));

router.get("/document-types", asyncHandler("Dokumententypen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const types = await documentStorage.getDocumentTypes(true, "employee");
  res.json(types);
}));

router.get("/documents", asyncHandler("Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const docs = await documentStorage.getCurrentDocuments(req.user!.id);
  res.json(docs);
}));

router.get("/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const documentTypeId = parseInt(req.params.documentTypeId);
  if (isNaN(documentTypeId)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Dokumententyp-ID" });
    return;
  }
  const docs = await documentStorage.getDocumentHistory(req.user!.id, documentTypeId);
  res.json(docs);
}));

router.post("/documents", asyncHandler("Dokument konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const data = { ...req.body, employeeId: req.user!.id, uploadedByUserId: req.user!.id };

  const { insertEmployeeDocumentSchema } = await import("@shared/schema");
  const result = insertEmployeeDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const docType = await documentStorage.getDocumentType(result.data.documentTypeId);
  if (!docType || docType.targetType !== "employee" || !docType.isActive) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültiger oder inaktiver Dokumententyp",
    });
    return;
  }

  const doc = await documentStorage.createEmployeeDocument(result.data);
  res.status(201).json(doc);
}));

export default router;
