import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { generatePdfFromHtml } from "./pdf-generator";
import { renderTemplate, buildPlaceholders, wrapInPrintableHtml } from "./template-engine";
import { documentStorage } from "../storage/documents";
import { computeDataHash } from "./signature-integrity";
import type { DocumentTemplate } from "@shared/schema";

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) throw new Error("Invalid path");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function getPrivateDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  return dir;
}

export async function generateAndStorePdf(options: {
  template: DocumentTemplate;
  customerId?: number;
  employeeId?: number;
  customerSignatureData?: string | null;
  employeeSignatureData?: string | null;
  placeholderOverrides?: Record<string, string>;
  generatedByUserId: number;
}): Promise<{
  objectPath: string;
  fileName: string;
  integrityHash: string;
  renderedHtml: string;
  generatedDocId: number;
}> {
  const { template, customerId, employeeId, customerSignatureData, employeeSignatureData, placeholderOverrides, generatedByUserId } = options;

  const overrides: Record<string, string> = { ...placeholderOverrides };
  if (customerSignatureData) {
    overrides.customer_signature = `<img src="${customerSignatureData}" alt="Kundenunterschrift" style="max-height:60px;" />`;
  }
  if (employeeSignatureData) {
    overrides.employee_signature = `<img src="${employeeSignatureData}" alt="Mitarbeiterunterschrift" style="max-height:60px;" />`;
  }

  let placeholders: Record<string, string>;
  if (customerId) {
    placeholders = await buildPlaceholders(customerId, overrides);
  } else {
    placeholders = { ...overrides };
  }

  const renderedHtml = renderTemplate(template.htmlContent, placeholders);

  const { pdfBuffer, integrityHash } = await generatePdfFromHtml(renderedHtml, template.name);

  const dateStr = new Date().toISOString().split("T")[0];
  const slug = template.slug.replace(/[^a-z0-9_-]/gi, "_");
  const targetLabel = customerId ? `kunde_${customerId}` : employeeId ? `mitarbeiter_${employeeId}` : "doc";
  const fileName = `${slug}_${targetLabel}_${dateStr}.pdf`;

  const privateDir = getPrivateDir();
  const objectFullPath = `${privateDir}/documents/${fileName}`;
  const { bucketName, objectName } = parseObjectPath(objectFullPath);

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(pdfBuffer, {
    contentType: "application/pdf",
    metadata: {
      integrityHash,
      templateSlug: template.slug,
      templateVersion: String(template.version),
    },
  });

  const objectPath = `/objects/documents/${fileName}`;

  const combinedHash = computeDataHash(
    JSON.stringify({
      pdfHash: integrityHash,
      customerSignature: customerSignatureData ? computeDataHash(customerSignatureData) : null,
      employeeSignature: employeeSignatureData ? computeDataHash(employeeSignatureData) : null,
      templateId: template.id,
      templateVersion: template.version,
    })
  );

  const generatedDoc = await documentStorage.createGeneratedDocument({
    customerId: customerId ?? null,
    employeeId: employeeId ?? null,
    templateId: template.id,
    templateVersion: template.version,
    documentTypeId: template.documentTypeId ?? null,
    fileName,
    objectPath,
    renderedHtml,
    customerSignatureData: customerSignatureData ?? null,
    employeeSignatureData: employeeSignatureData ?? null,
    integrityHash: combinedHash,
  }, generatedByUserId);

  return {
    objectPath,
    fileName,
    integrityHash: combinedHash,
    renderedHtml,
    generatedDocId: generatedDoc.id,
  };
}

export async function getDocumentPdfBuffer(objectPath: string): Promise<Buffer> {
  let fullPath: string;
  if (objectPath.startsWith("/objects/")) {
    const entityId = objectPath.slice("/objects/".length);
    let entityDir = getPrivateDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    fullPath = `${entityDir}${entityId}`;
  } else {
    fullPath = objectPath;
  }

  const { bucketName, objectName } = parseObjectPath(fullPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  const [exists] = await file.exists();
  if (!exists) throw new Error("PDF nicht gefunden");

  const [contents] = await file.download();
  return Buffer.from(contents);
}
