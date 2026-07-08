/**
 * Task #1716 — Sprechende Datei-Namen beim Download hochgeladener Dokumente/
 * Nachweise über die generische `/objects/*`-Streaming-Route.
 *
 * Task #1715 hat `downloadObject(file, res, ttl, { filename })` die Fähigkeit
 * gegeben, einen umlaut-sicheren `Content-Disposition`-Header (ASCII-Fallback +
 * RFC-5987 `filename*`) zu setzen. Die authentifizierte Route
 * `GET /objects/:objectPath(*)` (server/replit_integrations/object_storage/
 * routes.ts) reichte aber KEINEN Dateinamen durch — hochgeladene Kunden-/
 * Mitarbeiter-Dokumente, die direkt aus dem Object Storage gestreamt werden,
 * landeten daher unter ihrem UUID-artigen Objektpfad im „Speichern unter"-Dialog.
 *
 * Dieser Test seedet ein Kundendokument mit Umlaut-`fileName` (der reale Blob
 * trägt einen ASCII-Objektnamen) und fixiert, dass der `/objects/*`-Download
 *   - als `attachment` ausgeliefert wird,
 *   - den ASCII-Fallback (`filename="…"`, `ü→ue`/`ä→ae`) trägt,
 *   - die RFC-5987-Variante (`filename*=UTF-8''…`) trägt und
 *   - exakt dem `buildContentDisposition`-SSoT-Wert entspricht.
 *
 * Object-Storage-Guard via `describe` aus tests/helpers/object-storage → sauberer
 * Skip im No-Sidecar-CI.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { describe } from "../helpers/object-storage";
import { getAuthCookie, uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";
import { buildContentDisposition } from "../../shared/domain/invoice-export-filename";
import { db } from "../../server/lib/db";
import { customerDocuments, documentTypes } from "@shared/schema/documents";
import { inArray } from "drizzle-orm";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../../server/lib/object-storage-helpers";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let documentTypeId: number;
const createdDocIds: number[] = [];
const createdCustomerIds: number[] = [];

const UMLAUT_STEM = "Müller-Vertrag_Schäfer_Grüße";

async function seedCustomerDocument(customerId: number): Promise<{ objectPath: string; fileName: string }> {
  const id = uniqueId();
  const fileName = `${UMLAUT_STEM}-${id}.pdf`;
  // Der echte Blob trägt einen ASCII-Object-Namen; nur die Anzeige (`fileName`)
  // hat Umlaute — genau dieser Wert muss im Content-Disposition-Header landen.
  const objectFileName = `task1716-${id}.pdf`;
  const objectPath = `/objects/uploads/${objectFileName}`;

  let privateDir = getPrivateDir();
  if (!privateDir.endsWith("/")) privateDir = `${privateDir}/`;
  const fullPath = `${privateDir}uploads/${objectFileName}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF",
  );
  await objectStorageClient.bucket(bucketName).file(objectName).save(pdfBytes, {
    contentType: "application/pdf",
  });

  const [doc] = await db
    .insert(customerDocuments)
    .values({
      customerId,
      documentTypeId,
      fileName,
      objectPath,
      uploadedByUserId: auth.user.id,
    })
    .returning();
  createdDocIds.push(doc.id);
  return { objectPath, fileName };
}

async function fetchDisposition(path: string): Promise<{ status: number; contentType: string; contentDisposition: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: auth.cookie } });
  await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    contentDisposition: res.headers.get("content-disposition") ?? "",
  };
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const [dt] = await db
    .insert(documentTypes)
    .values({
      name: `Task-1716-Typ-${uniqueId()}`,
      targetType: "customer",
      context: "beide",
      inputMethod: "upload",
    })
    .returning();
  documentTypeId = dt.id;
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(customerDocuments).where(inArray(customerDocuments.id, createdDocIds));
  }
  if (documentTypeId) {
    await db.delete(documentTypes).where(inArray(documentTypes.id, [documentTypeId]));
  }
  for (const id of createdCustomerIds) {
    await cleanupCustomer(id);
  }
});

describe("/objects/*-Download: Umlaut-Dateiname bleibt erhalten (Task #1716)", () => {
  it("streamt Kundendokument mit sprechendem attachment-Content-Disposition", async () => {
    const customer = await createTestCustomer({ nachnamePrefix: "Obj1716" });
    createdCustomerIds.push(customer.id);
    const { objectPath, fileName } = await seedCustomerDocument(customer.id);

    const out = await fetchDisposition(objectPath);
    expect(out.status, "HTTP 200").toBe(200);
    expect(out.contentType).toContain("application/pdf");

    const expectedHeader = buildContentDisposition(fileName, "attachment");
    expect(out.contentDisposition).toBe(expectedHeader);
    expect(out.contentDisposition).toMatch(/^attachment;/);
    expect(out.contentDisposition).toMatch(/filename="[^"]*Mueller-Vertrag_Schaefer_Gruesse[^"]*"/);
    expect(out.contentDisposition).toContain("filename*=UTF-8''");
    expect(out.contentDisposition).toContain(encodeURIComponent(fileName));
  }, 120_000);
});
