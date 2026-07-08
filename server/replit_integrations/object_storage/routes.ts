import type { Express } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { authMiddleware, requireAuth } from "../../middleware/auth";
import { csrfProtection } from "../../middleware/csrf";
import { requireObjectAccess, resolveObjectFilename } from "../../middleware/object-storage-auth";
import { AppError, asyncHandler, badRequest, notFound } from "../../lib/errors";

export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  app.post(
    "/api/uploads/request-url",
    authMiddleware,
    requireAuth,
    csrfProtection,
    asyncHandler("Upload-URL konnte nicht erstellt werden", async (req, res) => {
      const { name, size, contentType } = req.body ?? {};

      if (!name) {
        throw badRequest("Dateiname fehlt — bitte wählen Sie eine Datei aus.");
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      });
    }),
  );

  app.get(
    "/objects/:objectPath(*)",
    authMiddleware,
    requireAuth,
    requireObjectAccess,
    asyncHandler("Datei konnte nicht geladen werden", async (req, res) => {
      try {
        const objectFile = await objectStorageService.getObjectEntityFile(req.path);
        const filename = await resolveObjectFilename(req.path);
        await objectStorageService.downloadObject(objectFile, res, 3600, { filename });
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          throw notFound("Datei nicht gefunden");
        }
        throw error;
      }
    }),
  );
}
