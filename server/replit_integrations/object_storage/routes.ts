import type { Express } from "express";
import { raw } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { authMiddleware, requireAuth } from "../../middleware/auth";
import { csrfProtection } from "../../middleware/csrf";
import { requireObjectAccess, resolveObjectFilename } from "../../middleware/object-storage-auth";
import { AppError, asyncHandler, badRequest, forbidden, notFound } from "../../lib/errors";
import { getStorageDriver } from "../../lib/storage";
import { verifyLocalUploadToken } from "../../lib/storage/local-upload-token";
import { parseObjectPath, getPrivateDir } from "../../lib/object-storage-helpers";

// UUID-Form (randomUUID) — der Upload-Objektschlüssel MUSS diesem Muster
// entsprechen, damit kein manipulierter Pfad in den uploads/-Namespace gelangt.
const UPLOAD_OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  // local-Treiber: Ziel des Browser-Direkt-PUT (Ersatz für die GCS-Presigned-
  // URL). Authentifizierung ist der kurzlebige HMAC-Token in der Query — dasselbe
  // Capability-Modell wie eine Presigned-URL, daher bewusst KEIN CSRF/Session
  // (der Token ist kein ambient credential). Ausgestellt wird er nur über den
  // auth+CSRF-geschützten /api/uploads/request-url-Endpoint.
  app.put(
    "/api/uploads/local/:objectId",
    raw({ type: () => true, limit: "25mb" }),
    asyncHandler("Datei konnte nicht hochgeladen werden", async (req, res) => {
      if ((process.env.STORAGE_DRIVER ?? "replit").toLowerCase() !== "local") {
        throw notFound("Lokaler Upload-Endpoint ist nur mit STORAGE_DRIVER=local aktiv.");
      }
      const { objectId } = req.params;
      const verdict = verifyLocalUploadToken(
        typeof req.query.token === "string" ? req.query.token : undefined,
      );
      if (!verdict.ok || verdict.objectId !== objectId) {
        throw forbidden("UPLOAD_TOKEN_INVALID", "Upload-Token ungültig oder abgelaufen.");
      }
      if (!UPLOAD_OBJECT_ID_RE.test(objectId)) {
        throw badRequest("Ungültiger Upload-Objektschlüssel.");
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw badRequest("Kein Datei-Inhalt empfangen.");
      }

      let privateDir = getPrivateDir();
      if (!privateDir.endsWith("/")) privateDir = `${privateDir}/`;
      const { bucketName, objectName } = parseObjectPath(`${privateDir}uploads/${objectId}`);
      const contentType = req.get("content-type") || "application/octet-stream";
      await getStorageDriver().bucket(bucketName).file(objectName).save(req.body, { contentType });

      res.status(200).json({ ok: true });
    }),
  );

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
