import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { generatePdfFromHtml } from "./pdf-generator";
import { renderTemplate, buildPlaceholders, wrapInPrintableHtml } from "./template-engine";
import { documentStorage } from "../storage/documents";
import { computeDataHash } from "./signature-integrity";
import { todayISO, formatDateForDisplay } from "@shared/utils/datetime";
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

async function storePdfToObjectStorage(pdfBuffer: Buffer, fileName: string, metadata: Record<string, string>): Promise<string> {
  const privateDir = getPrivateDir();
  const objectFullPath = `${privateDir}/documents/${fileName}`;
  const { bucketName, objectName } = parseObjectPath(objectFullPath);

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(pdfBuffer, {
    contentType: "application/pdf",
    metadata,
  });

  return `/objects/documents/${fileName}`;
}

export async function generateAndStorePdf(options: {
  template: DocumentTemplate;
  customerId?: number;
  employeeId?: number;
  customerSignatureData?: string | null;
  employeeSignatureData?: string | null;
  placeholderOverrides?: Record<string, string>;
  generatedByUserId: number;
  signingStatus?: "complete" | "pending_employee_signature";
}): Promise<{
  objectPath: string;
  fileName: string;
  integrityHash: string;
  renderedHtml: string;
  generatedDocId: number;
}> {
  const { template, customerId, employeeId, customerSignatureData, employeeSignatureData, placeholderOverrides, generatedByUserId, signingStatus = "complete" } = options;

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

  const dateStr = todayISO();
  const slug = template.slug.replace(/[^a-z0-9_-]/gi, "_");
  const targetLabel = customerId ? `kunde_${customerId}` : employeeId ? `mitarbeiter_${employeeId}` : "doc";
  const fileName = `${slug}_${targetLabel}_${dateStr}.pdf`;

  const objectPath = await storePdfToObjectStorage(pdfBuffer, fileName, {
    integrityHash,
    templateSlug: template.slug,
    templateVersion: String(template.version),
  });

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
    signingStatus,
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

export async function regeneratePdfWithSignature(
  doc: import("@shared/schema").GeneratedDocument,
  employeeSignatureData: string,
): Promise<{ objectPath: string; fileName: string; integrityHash: string }> {
  if (!doc.renderedHtml) throw new Error("Kein gerendertetes HTML vorhanden");

  const sigHtml = `<img src="${employeeSignatureData}" alt="Mitarbeiterunterschrift" style="max-height:60px;" />`;
  let updatedHtml = doc.renderedHtml;
  if (updatedHtml.includes("{{employee_signature}}")) {
    updatedHtml = updatedHtml.replace(/\{\{employee_signature\}\}/g, sigHtml);
  } else {
    updatedHtml += `<div style="margin-top:40px;"><p><strong>Unterschrift Mitarbeiter:</strong></p>${sigHtml}<p style="font-size:10px;color:#666;">Datum: ${formatDateForDisplay(todayISO())}</p></div>`;
  }

  const { pdfBuffer, integrityHash: pdfHash } = await generatePdfFromHtml(updatedHtml, doc.fileName);

  const dateStr = todayISO();
  const baseName = doc.fileName.replace(/\.pdf$/i, "");
  const fileName = `${baseName}_signed_${dateStr}.pdf`;

  const objectPath = await storePdfToObjectStorage(pdfBuffer, fileName, {
    integrityHash: pdfHash,
    originalDocumentId: String(doc.id),
  });

  const combinedHash = computeDataHash(
    JSON.stringify({
      pdfHash,
      customerSignature: doc.customerSignatureData ? computeDataHash(doc.customerSignatureData) : null,
      employeeSignature: computeDataHash(employeeSignatureData),
      templateId: doc.templateId,
      templateVersion: doc.templateVersion,
    })
  );

  return { objectPath, fileName, integrityHash: combinedHash };
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
