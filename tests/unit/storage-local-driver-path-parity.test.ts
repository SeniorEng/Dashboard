/**
 * Task #1840 — Pfad-Paritäts-Test für den lokalen Storage-Treiber.
 *
 * KERNGARANTIE der Migration: Ein Pfad-String, wie er HEUTE in der DB steht
 * (`invoices.pdf_path`, `documents.object_path`, …), muss im `local`-Treiber
 * 1:1 dieselbe Datei treffen — inklusive der `.private/`-Präfix- und Bucket-
 * Logik, die aus `PRIVATE_OBJECT_DIR` stammt. Nur so ist die Umstellung ohne
 * DB-Migration korrekt.
 *
 * Der Test schreibt über EXAKT dieselbe (bucket,object)-Zerlegung wie die App
 * beim Schreiben (`parseObjectPath(getPrivateDir() + "/" + objectKey)`) und liest
 * anschließend über den öffentlichen App-Pfad `ObjectStorageService
 * .getObjectEntityFile("/objects/<key>")` zurück. Zusätzlich wird die PHYSISCHE
 * Lage der Datei explizit geprüft (`<root>/<bucket>/.private/<key>`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getStorageDriver, __resetStorageDriverCacheForTests } from "../../server/lib/storage";
import { parseObjectPath, getPrivateDir } from "../../server/lib/object-storage-helpers";
import { ObjectStorageService } from "../../server/replit_integrations/object_storage/objectStorage";
import {
  setObjectAclPolicy,
  getObjectAclPolicy,
} from "../../server/replit_integrations/object_storage/objectAcl";

const ENV_KEYS = [
  "STORAGE_DRIVER",
  "FILE_STORAGE_ROOT",
  "PRIVATE_OBJECT_DIR",
  "PUBLIC_OBJECT_SEARCH_PATHS",
] as const;

/**
 * Spiegelt EXAKT die Schreib-Zerlegung der App (Orchestrator/document-pdf):
 * `parseObjectPath(getPrivateDir() + "/" + objectKey)`.
 */
function decomposeForWrite(objectKey: string): { bucketName: string; objectName: string } {
  let entityDir = getPrivateDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  return parseObjectPath(`${entityDir}${objectKey}`);
}

describe("local-Treiber — Pfad-Parität mit heutigen DB-Pfaden (Task #1840)", () => {
  let saved: Record<string, string | undefined>;
  let root: string;
  const BUCKET = "meinbucket";

  beforeEach(async () => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = await mkdtemp(join(tmpdir(), "cc-local-storage-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.FILE_STORAGE_ROOT = root;
    process.env.PRIVATE_OBJECT_DIR = `/${BUCKET}/.private`;
    process.env.PUBLIC_OBJECT_SEARCH_PATHS = `/${BUCKET}/public`;
    __resetStorageDriverCacheForTests();
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetStorageDriverCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("Prod-Bare-Rechnungspfad trifft dieselbe Datei (physisch <root>/<bucket>/.private/invoices/…)", async () => {
    const objectKey = "invoices/RE-2026-0034.pdf";
    const storedDbPath = `/objects/${objectKey}`; // exakt wie in invoices.pdf_path
    const bytes = Buffer.from("PDF-BYTES-RE-0034");

    // Schreiben über die App-Zerlegung + Treiber:
    const { bucketName, objectName } = decomposeForWrite(objectKey);
    await getStorageDriver().bucket(bucketName).file(objectName).save(bytes, {
      contentType: "application/pdf",
    });

    // Physische Lage EXPLIZIT: Bucket + .private/ müssen im Pfad stehen.
    const expectedFsPath = join(root, BUCKET, ".private", "invoices", "RE-2026-0034.pdf");
    expect(existsSync(expectedFsPath)).toBe(true);

    // Lesen über den öffentlichen App-Pfad (rekonstruiert bucket/object selbst):
    const svc = new ObjectStorageService();
    const file = await svc.getObjectEntityFile(storedDbPath);
    const [readBytes] = await file.download();
    expect(readBytes.equals(bytes)).toBe(true);

    // Content-Type kommt aus dem Sidecar zurück.
    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("application/pdf");
  });

  it("documents/-Pfad trifft dieselbe Datei", async () => {
    const objectKey = "documents/vertrag_kunde_39_2026-07-01.pdf";
    const storedDbPath = `/objects/${objectKey}`;
    const bytes = Buffer.from("DOC-BYTES");
    const { bucketName, objectName } = decomposeForWrite(objectKey);
    await getStorageDriver().bucket(bucketName).file(objectName).save(bytes);

    const svc = new ObjectStorageService();
    const [readBytes] = await (await svc.getObjectEntityFile(storedDbPath)).download();
    expect(readBytes.equals(bytes)).toBe(true);
  });

  it("Legacy _nonprod/<env>-Pfad löst 1:1 auf (Treiber ignoriert das Präfix semantisch)", async () => {
    // So sieht ein in einer Nicht-Prod-DB gespeicherter pdf_path aus (Task #1042).
    const objectKey = "_nonprod/development/invoices/RE-2026-0034.pdf";
    const storedDbPath = `/objects/${objectKey}`;
    const bytes = Buffer.from("NONPROD-BYTES");
    const { bucketName, objectName } = decomposeForWrite(objectKey);
    await getStorageDriver().bucket(bucketName).file(objectName).save(bytes);

    const expectedFsPath = join(
      root, BUCKET, ".private", "_nonprod", "development", "invoices", "RE-2026-0034.pdf",
    );
    expect(existsSync(expectedFsPath)).toBe(true);

    const svc = new ObjectStorageService();
    const [readBytes] = await (await svc.getObjectEntityFile(storedDbPath)).download();
    expect(readBytes.equals(bytes)).toBe(true);
  });

  it("ACL-Policy round-trippt über das Sidecar (setObjectAclPolicy/getObjectAclPolicy)", async () => {
    const objectKey = "uploads/abc-123";
    const { bucketName, objectName } = decomposeForWrite(objectKey);
    const file = getStorageDriver().bucket(bucketName).file(objectName);
    await file.save(Buffer.from("LOGO"), { contentType: "image/png" });

    await setObjectAclPolicy(file, { owner: "user-7", visibility: "public" });
    const policy = await getObjectAclPolicy(file);
    expect(policy).toEqual({ owner: "user-7", visibility: "public" });

    // Content-Type bleibt beim setMetadata-Merge erhalten.
    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("image/png");
  });

  it("öffentlicher Suchpfad findet ein unter <root>/<bucket>/public abgelegtes Objekt", async () => {
    // Datei physisch dort ablegen, wo der Public-Search-Path auflöst.
    const publicFsDir = join(root, BUCKET, "public", "branding");
    await mkdir(publicFsDir, { recursive: true });
    await writeFile(join(publicFsDir, "opengraph.jpg"), Buffer.from("OG"));

    const svc = new ObjectStorageService();
    const found = await svc.searchPublicObject("branding/opengraph.jpg");
    expect(found).not.toBeNull();
    const [bytes] = await found!.download();
    expect(bytes.toString()).toBe("OG");
  });

  it("lehnt Path-Traversal im objectName ab (Sicherheits-Guard)", async () => {
    const driver = getStorageDriver();
    expect(() => driver.bucket(BUCKET).file("../../etc/passwd")).toThrow(/Path-Traversal/);
  });

  it("delete entfernt Objekt UND Sidecar", async () => {
    const { bucketName, objectName } = decomposeForWrite("uploads/to-delete");
    const file = getStorageDriver().bucket(bucketName).file(objectName);
    await file.save(Buffer.from("X"), { contentType: "text/plain" });
    const fsPath = join(root, BUCKET, ".private", "uploads", "to-delete");
    expect(existsSync(fsPath)).toBe(true);
    expect(existsSync(`${fsPath}.meta.json`)).toBe(true);

    await file.delete();
    expect(existsSync(fsPath)).toBe(false);
    expect(existsSync(`${fsPath}.meta.json`)).toBe(false);
    const [exists] = await file.exists();
    expect(exists).toBe(false);
  });
});
