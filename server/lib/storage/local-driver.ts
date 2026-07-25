// ---------------------------------------------------------------------------
// Replit-Exit — lokaler Dateisystem-Storage-Treiber (Task #1840).
//
// Bildet das treiberneutrale (bucket, objectName)-Paar — das ObjectStorageService
// und die Konsumenten aus den in der DB gespeicherten `/objects/<key>`-Pfaden
// ableiten — deterministisch aufs Dateisystem ab:
//
//     FILE_STORAGE_ROOT / <bucketName> / <objectName>
//
// Da der `.private/…`-Anteil und der Bucket bereits im `objectName` bzw.
// `bucketName` stecken (aus `PRIVATE_OBJECT_DIR`), lösen heute gespeicherte
// Pfad-Strings 1:1 auf dieselbe Datei auf — ohne DB-Migration. Die
// `_nonprod/`-Präfix-Logik ist NICHT Sache des Treibers (sie steckt ggf. schon
// im gespeicherten Key); Umgebungs-Trennung erfolgt physisch über getrennte
// `FILE_STORAGE_ROOT`-Volumes pro Umgebung.
//
// ACL-/Content-Type-Metadata liegt als Sidecar `<datei>.meta.json` neben dem
// Objekt (dieselbe `metadata.metadata[...]`-Form wie GCS, damit objectAcl.ts
// unverändert funktioniert).
// ---------------------------------------------------------------------------
import { createReadStream, type Dirent } from "fs";
import { mkdir, readFile, writeFile, stat, unlink, readdir } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import type {
  StorageDriver,
  StoredBucket,
  StoredFile,
  StoredFileMetadata,
  StoredFileSaveOptions,
} from "./types";

const META_SUFFIX = ".meta.json";

function getStorageRoot(): string {
  const root = process.env.FILE_STORAGE_ROOT?.trim();
  if (!root) {
    throw new Error(
      "FILE_STORAGE_ROOT ist nicht gesetzt, wird aber von STORAGE_DRIVER=local " +
        "benötigt (Volume-Mount-Pfad für lokale Objekt-Ablage).",
    );
  }
  return root;
}

/**
 * Mappt (bucket, objectName) auf einen absoluten FS-Pfad und verhindert
 * Path-Traversal: der aufgelöste Pfad MUSS unterhalb von <root>/<bucket>
 * liegen. Ein `objectName` mit `..`-Ausbruch wird hart abgelehnt.
 */
function resolveObjectFsPath(bucket: string, objectName: string): string {
  const root = getStorageRoot();
  if (!bucket || bucket.includes("/") || bucket === "." || bucket === "..") {
    throw new Error(`Ungültiger Bucket-Name: "${bucket}"`);
  }
  const base = resolve(root, bucket);
  const target = resolve(base, objectName);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(
      `Path-Traversal abgelehnt: objectName "${objectName}" verlässt den ` +
        `Bucket-Namespace.`,
    );
  }
  return target;
}

class LocalStoredFile implements StoredFile {
  readonly name: string;
  private readonly fsPath: string;
  private readonly metaPath: string;

  constructor(bucket: string, objectName: string) {
    this.name = objectName;
    this.fsPath = resolveObjectFsPath(bucket, objectName);
    this.metaPath = `${this.fsPath}${META_SUFFIX}`;
  }

  async exists(): Promise<[boolean]> {
    try {
      await stat(this.fsPath);
      return [true];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [false];
      throw err;
    }
  }

  async download(): Promise<[Buffer]> {
    return [await readFile(this.fsPath)];
  }

  async save(data: Buffer | Uint8Array, opts?: StoredFileSaveOptions): Promise<void> {
    await mkdir(dirname(this.fsPath), { recursive: true });
    await writeFile(this.fsPath, data);
    const meta: StoredFileMetadata = {
      contentType: opts?.contentType,
      metadata: opts?.metadata ?? {},
    };
    await writeFile(this.metaPath, JSON.stringify(meta), "utf-8");
  }

  createReadStream(): NodeJS.ReadableStream {
    return createReadStream(this.fsPath);
  }

  async getMetadata(): Promise<[StoredFileMetadata]> {
    let size: number | undefined;
    try {
      size = (await stat(this.fsPath)).size;
    } catch {
      size = undefined;
    }
    let sidecar: { contentType?: string; metadata?: Record<string, string> } = {};
    try {
      sidecar = JSON.parse(await readFile(this.metaPath, "utf-8"));
    } catch {
      // Kein Sidecar (z.B. extern abgelegtes Objekt) → leere Metadata.
    }
    return [
      {
        contentType: sidecar.contentType,
        size,
        metadata: sidecar.metadata ?? {},
      },
    ];
  }

  async setMetadata(md: { metadata?: Record<string, string> }): Promise<unknown> {
    let existing: { contentType?: string; metadata?: Record<string, string> } = {};
    try {
      existing = JSON.parse(await readFile(this.metaPath, "utf-8"));
    } catch {
      // noch kein Sidecar
    }
    const merged = {
      contentType: existing.contentType,
      metadata: { ...(existing.metadata ?? {}), ...(md.metadata ?? {}) },
    };
    await writeFile(this.metaPath, JSON.stringify(merged), "utf-8");
    return merged;
  }

  async delete(): Promise<unknown> {
    for (const p of [this.fsPath, this.metaPath]) {
      try {
        await unlink(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return undefined;
  }
}

class LocalStoredBucket implements StoredBucket {
  constructor(private readonly bucket: string) {}

  file(name: string): StoredFile {
    return new LocalStoredFile(this.bucket, name);
  }

  async getFiles(opts?: { prefix?: string }): Promise<[StoredFile[]]> {
    const bucketRoot = resolveObjectFsPath(this.bucket, "");
    const prefix = opts?.prefix ?? "";
    const bucket = this.bucket;
    const results: StoredFile[] = [];

    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), childRel);
        } else if (entry.isFile() && !entry.name.endsWith(META_SUFFIX)) {
          if (childRel.startsWith(prefix)) {
            results.push(new LocalStoredFile(bucket, childRel));
          }
        }
      }
    };
    await walk(bucketRoot, "");
    return [results];
  }
}

export const localStorageDriver: StorageDriver = {
  bucket(name: string): StoredBucket {
    return new LocalStoredBucket(name);
  },
  createUploadUrl(): Promise<string> {
    // Der Browser-Direkt-PUT-Ersatz (signierter lokaler Upload-Endpoint) folgt
    // bewusst separat (Commit 4b). Bis dahin ist der Upload-Flow im local-Treiber
    // nicht verfügbar; Lesen/Schreiben serverseitig (PDFs, Logos) funktioniert.
    throw new Error(
      "Lokaler Upload-Endpoint ist noch nicht implementiert (folgt in Commit 4b). " +
        "STORAGE_DRIVER=local unterstützt bereits serverseitiges Lesen/Schreiben.",
    );
  },
};
