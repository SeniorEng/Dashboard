import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";

export interface LogoBytes {
  content: Buffer;
  contentType: string;
}

let cachedBytes: LogoBytes | null = null;
let cachedPath: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Loads the raw logo bytes + content-type from object storage. Shared by
 * `resolveLogoToDataUrl` (PDF/document inline data-URLs) and the email layer
 * (inline `cid:` attachments — Task #1092). Results are cached per path for
 * CACHE_TTL_MS so repeated sends in one batch hit the bucket only once.
 */
export async function loadLogoBytes(logoPath: string | null | undefined): Promise<LogoBytes | null> {
  if (!logoPath) return null;

  const now = Date.now();
  if (cachedPath === logoPath && cachedBytes && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedBytes;
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

    const result: LogoBytes = { content: buffer, contentType };
    cachedBytes = result;
    cachedPath = logoPath;
    cacheTimestamp = now;
    return result;
  } catch (err) {
    console.error("Logo-Auflösung fehlgeschlagen:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function resolveLogoToDataUrl(logoPath: string | null | undefined): Promise<string | null> {
  const bytes = await loadLogoBytes(logoPath);
  if (!bytes) return null;
  return `data:${bytes.contentType};base64,${bytes.content.toString("base64")}`;
}
