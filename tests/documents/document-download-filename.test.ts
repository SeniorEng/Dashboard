/**
 * Task #1709 — Umlaut-sichere Datei-Namen beim Download hochgeladener/generierter
 * Dokumente aus der Dokumentenverwaltung.
 *
 * Die Rechnungs-Zeilen-Downloads (Rechnung/Leistungsnachweis/Bündel) setzen ihren
 * `Content-Disposition`-Header seit Task #1696/#1701 über die SSoT
 * `buildContentDisposition` (ASCII-Fallback + RFC-5987 `filename*`). Die beiden
 * Dokumentenverwaltungs-Download-Routen bauten den Header dagegen noch von Hand als
 * schlichtes `inline; filename="${doc.fileName}"` OHNE `filename*` — Umlaute im
 * Dateinamen (z.B. „Müller-Vertrag.pdf") wurden im „Speichern unter"-Dialog
 * verstümmelt.
 *
 * Getroffene Routen:
 *   - GET /api/customers/generated-documents/:docId/download (customerId gesetzt)
 *   - GET /api/admin/generated-documents/:id/download
 *
 * Der Test seedet je ein generiertes Dokument mit Umlaut-Dateinamen (der reale
 * Object-Storage-Blob trägt einen ASCII-Namen; nur die Anzeige/`fileName` hat
 * Umlaute) und fixiert, dass der Content-Disposition-Header
 *   - den ASCII-Fallback (`filename="…"`, `ü→ue`/`ä→ae`) trägt,
 *   - die RFC-5987-Variante (`filename*=UTF-8''…`, percent-encoded) trägt und
 *   - exakt dem von `buildContentDisposition` erzeugten Wert entspricht.
 *
 * Object-Storage-Guard via `describe` aus tests/helpers/object-storage → sauberer
 * Skip im No-Sidecar-CI, analog tests/billing/single-doc-download-filename.test.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { describe } from "../helpers/object-storage";
import { getAuthCookie, uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";
import { buildContentDisposition } from "../../shared/domain/invoice-export-filename";
import { db } from "../../server/lib/db";
import { documentTemplates, generatedDocuments } from "@shared/schema";
import { inArray } from "drizzle-orm";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../../server/lib/object-storage-helpers";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let templateId: number;
const createdDocIds: number[] = [];
const createdCustomerIds: number[] = [];

// Umlaute im Dateinamen: erzwingt sowohl den ASCII-Fallback (Umlaut ausgeschrieben)
// als auch die percent-encodete RFC-5987-Variante.
const UMLAUT_STEM = "Müller-Vertrag_Schäfer_Grüße";

async function seedGeneratedDocument(customerId: number | null): Promise<{ docId: number; fileName: string }> {
  const id = uniqueId();
  const fileName = `${UMLAUT_STEM}-${id}.pdf`;
  // Der echte Blob trägt einen ASCII-Object-Namen; nur die Anzeige (`fileName`)
  // hat Umlaute — genau dieser Wert landet im Content-Disposition-Header.
  const objectFileName = `task1709-${id}.pdf`;
  const objectPath = `/objects/documents/${objectFileName}`;

  // Minimales, gültiges PDF in den Object Storage schreiben (mirror von
  // storePdfToObjectStorage in server/services/document-pdf.ts).
  let privateDir = getPrivateDir();
  if (!privateDir.endsWith("/")) privateDir = `${privateDir}/`;
  const fullPath = `${privateDir}documents/${objectFileName}`;
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
    .insert(generatedDocuments)
    .values({
      customerId,
      employeeId: customerId ? null : auth.user.id,
      templateId,
      templateVersion: 1,
      fileName,
      objectPath,
      renderedHtml: "<p>Task #1709</p>",
      signingStatus: "complete",
      generatedByUserId: auth.user.id,
    })
    .returning();
  createdDocIds.push(doc.id);
  return { docId: doc.id, fileName };
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

  const [tpl] = await db
    .insert(documentTemplates)
    .values({
      slug: `task1709-tpl-${uniqueId()}`,
      name: "Task-1709-Download-Template",
      htmlContent: "<p>Task #1709</p>",
      version: 1,
      isSystem: false,
      isActive: true,
      context: "beide",
      targetType: "beide",
      requiresCustomerSignature: false,
      requiresEmployeeSignature: false,
    })
    .returning();
  templateId = tpl.id;
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(generatedDocuments).where(inArray(generatedDocuments.id, createdDocIds));
  }
  if (templateId) {
    await db.delete(documentTemplates).where(inArray(documentTemplates.id, [templateId]));
  }
  for (const id of createdCustomerIds) {
    await cleanupCustomer(id);
  }
});

describe("Dokumenten-Download-Header: Umlaut-Dateiname bleibt erhalten (Task #1709)", () => {
  it("customers-Route: Content-Disposition trägt ASCII-Fallback + filename*", async () => {
    const customer = await createTestCustomer({ nachnamePrefix: "Doc1709C" });
    createdCustomerIds.push(customer.id);
    const { docId, fileName } = await seedGeneratedDocument(customer.id);

    const out = await fetchDisposition(`/api/customers/generated-documents/${docId}/download`);
    expect(out.status, "HTTP 200").toBe(200);
    expect(out.contentType).toContain("application/pdf");

    const expectedHeader = buildContentDisposition(fileName, "inline");
    expect(out.contentDisposition).toBe(expectedHeader);
    expect(out.contentDisposition).toMatch(/filename="[^"]*Mueller-Vertrag_Schaefer_Gruesse[^"]*"/);
    expect(out.contentDisposition).toContain("filename*=UTF-8''");
    expect(out.contentDisposition).toContain(encodeURIComponent(fileName));
  }, 120_000);

  it("admin-Route: Content-Disposition trägt ASCII-Fallback + filename*", async () => {
    const { docId, fileName } = await seedGeneratedDocument(null);

    const out = await fetchDisposition(`/api/admin/generated-documents/${docId}/download`);
    expect(out.status, "HTTP 200").toBe(200);
    expect(out.contentType).toContain("application/pdf");

    const expectedHeader = buildContentDisposition(fileName, "inline");
    expect(out.contentDisposition).toBe(expectedHeader);
    expect(out.contentDisposition).toMatch(/filename="[^"]*Mueller-Vertrag_Schaefer_Gruesse[^"]*"/);
    expect(out.contentDisposition).toContain("filename*=UTF-8''");
    expect(out.contentDisposition).toContain(encodeURIComponent(fileName));
  }, 120_000);
});
