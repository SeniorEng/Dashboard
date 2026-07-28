// ---------------------------------------------------------------------------
// Replit-Exit — Storage-Treiber-Auswahl (Task #1840).
//
//   STORAGE_DRIVER=replit (Default) → Replit/GCS via Sidecar (heutiger Pfad)
//   STORAGE_DRIVER=local            → lokaler Dateisystem-Treiber (Folgeschritt)
//
// Additiv/Strangler: Ohne gesetzte Variable bleibt alles beim Replit-Treiber.
// ---------------------------------------------------------------------------
import type { StorageDriver } from "./types";
import { replitStorageDriver } from "./replit-driver";
import { localStorageDriver } from "./local-driver";

export type { StorageDriver, StoredBucket, StoredFile, StoredFileMetadata, StoredFileSaveOptions } from "./types";

let cached: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER ?? "replit").trim().toLowerCase();
  switch (driver) {
    case "replit":
      cached = replitStorageDriver;
      break;
    case "local":
      cached = localStorageDriver;
      break;
    default:
      throw new Error(
        `STORAGE_DRIVER muss "replit" oder "local" sein (ist: "${driver}").`,
      );
  }
  return cached;
}

// Test-Hook: erlaubt das Zurücksetzen des Treiber-Caches zwischen Tests, die
// `STORAGE_DRIVER` variieren. Im Produktivbetrieb ungenutzt.
export function __resetStorageDriverCacheForTests(): void {
  cached = null;
}
