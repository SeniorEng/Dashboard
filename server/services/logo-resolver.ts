import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) throw new Error("Invalid path");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function getPrivateDir(): string {
  return process.env.PRIVATE_OBJECT_DIR || "";
}

let cachedDataUrl: string | null = null;
let cachedPath: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function resolveLogoToDataUrl(logoPath: string | null | undefined): Promise<string | null> {
  if (!logoPath) return null;

  const now = Date.now();
  if (cachedPath === logoPath && cachedDataUrl && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedDataUrl;
  }

  try {
    let fullPath: string;
    if (logoPath.startsWith("/objects/")) {
      const entityId = logoPath.slice("/objects/".length);
      let entityDir = getPrivateDir();
      if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
      fullPath = `${entityDir}${entityId}`;
    } else {
      fullPath = logoPath;
    }

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    const [exists] = await file.exists();
    if (!exists) return null;

    const [contents] = await file.download();
    const buffer = Buffer.from(contents);

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || "image/png";

    const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    cachedDataUrl = dataUrl;
    cachedPath = logoPath;
    cacheTimestamp = now;
    return dataUrl;
  } catch (err) {
    console.error("Logo-Auflösung fehlgeschlagen:", err instanceof Error ? err.message : err);
    return null;
  }
}
