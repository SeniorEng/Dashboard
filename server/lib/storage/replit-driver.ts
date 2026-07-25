// ---------------------------------------------------------------------------
// Replit-Exit — Replit/GCS-Storage-Treiber (Task #1840).
//
// Dünner Adapter, der den bestehenden Google-Cloud-Storage-Client (via Replit-
// Object-Storage-Sidecar) hinter das `StorageDriver`-Interface legt. Der Client
// selbst bleibt in `server/replit_integrations/object_storage/objectStorage.ts`
// (nicht verschoben/gelöscht — Replit-Betrieb bis zum Cutover unverändert).
//
// GCS-`Bucket`/`File`-Objekte erfüllen `StoredBucket`/`StoredFile` strukturell,
// daher werden sie unverändert durchgereicht (Cast auf das schmalere Interface).
// ---------------------------------------------------------------------------
import { objectStorageClient } from "../../replit_integrations/object_storage/objectStorage";
import type { StorageDriver, StoredBucket } from "./types";

// Bekannter, fester Sidecar-Endpoint (identisch zu objectStorage.ts). Bewusst
// dupliziert statt exportiert, um die bestehende Datei nicht zu verändern.
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function signObjectURL(
  objectPath: string,
  ttlSec: number,
): Promise<string> {
  const { bucketName, objectName } = parseObjectPath(objectPath);
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method: "PUT" as const,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }
  const { signed_url: signedURL } = await response.json();
  return signedURL;
}

export const replitStorageDriver: StorageDriver = {
  bucket(name: string): StoredBucket {
    // GCS-Bucket erfüllt StoredBucket strukturell (file(), getFiles()).
    return objectStorageClient.bucket(name) as unknown as StoredBucket;
  },
  createUploadUrl(objectPath: string, ttlSec: number): Promise<string> {
    return signObjectURL(objectPath, ttlSec);
  },
};
