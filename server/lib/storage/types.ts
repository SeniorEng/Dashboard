// ---------------------------------------------------------------------------
// Replit-Exit — Storage-Treiber-Abstraktion (Task #1840).
//
// Die App sprach den Object-Storage bislang direkt über den Google-Cloud-
// Storage-Client (`@google-cloud/storage`) via Replit-Sidecar an. Für den
// Betrieb auf Hetzner/Coolify führen wir eine dünne Treiber-Abstraktion ein,
// hinter die neben dem bestehenden Replit/GCS-Treiber ein lokaler Datei-
// system-Treiber (Task-Folgeschritt) gehängt werden kann.
//
// Bewusst STRUKTURELL an der real genutzten GCS-`File`/`Bucket`-Teilmenge
// orientiert: Der Replit-Adapter gibt die echten GCS-Objekte unverändert
// zurück (sie erfüllen dieses Interface strukturell), sodass die Umstellung
// verhaltensneutral ist und die Aufrufer nur ihren Import wechseln, nicht ihre
// Aufrufform (`driver.bucket(b).file(o).save(...)` etc.).
// ---------------------------------------------------------------------------

/** Optionen für `StoredFile.save` — Teilmenge der GCS-`SaveOptions`. */
export interface StoredFileSaveOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

/** Aus `getMetadata()` gelesene Felder — Teilmenge der GCS-`FileMetadata`. */
export interface StoredFileMetadata {
  contentType?: string;
  size?: string | number;
  /** Custom-Metadata (u.a. die ACL-Policy unter `custom:aclPolicy`). */
  metadata?: Record<string, string>;
}

/**
 * Ein einzelnes Objekt im Storage. Die Methoden-Signaturen (Tupel-Rückgaben
 * wie `[boolean]`/`[Buffer]`) spiegeln bewusst die GCS-`File`-API, damit der
 * Replit-Adapter GCS-`File`-Instanzen ohne Wrapper zurückgeben kann.
 */
export interface StoredFile {
  /** Objekt-Name (Key relativ zum Bucket). */
  readonly name: string;
  exists(): Promise<[boolean]>;
  download(): Promise<[Buffer]>;
  save(data: Buffer | Uint8Array, opts?: StoredFileSaveOptions): Promise<void>;
  createReadStream(): NodeJS.ReadableStream;
  getMetadata(): Promise<[StoredFileMetadata]>;
  setMetadata(md: { metadata?: Record<string, string> }): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** Ein Bucket (Namespace für Objekte). */
export interface StoredBucket {
  file(name: string): StoredFile;
  getFiles(opts?: { prefix?: string }): Promise<[StoredFile[]]>;
}

/**
 * Der Storage-Treiber. Auswahl zur Laufzeit über `STORAGE_DRIVER`
 * (siehe `getStorageDriver()`).
 */
export interface StorageDriver {
  bucket(name: string): StoredBucket;
  /**
   * Erzeugt eine URL, auf die der Browser das Objekt DIREKT per HTTP-PUT laden
   * kann. Replit: eine über den Sidecar signierte GCS-URL. Lokal (Folgeschritt):
   * ein eigener authentifizierter Upload-Endpoint der App.
   *
   * `objectPath` ist der vollständige Pfad `/<bucket>/<objectName>`.
   */
  createUploadUrl(objectPath: string, ttlSec: number): Promise<string>;
}
