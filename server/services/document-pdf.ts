import crypto from "crypto";
import path from "path";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { generatePdfFromHtml } from "./pdf-generator";
import { renderTemplate, buildPlaceholders, wrapInPrintableHtml, escapeHtml } from "./template-engine";
import { documentStorage } from "../storage/documents";
import { computeDataHash } from "./signature-integrity";
import { todayISO, formatDateForDisplay } from "@shared/utils/datetime";
import type { DocumentTemplate } from "@shared/schema";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";
import { badRequest } from "../lib/errors";
import type { Request, Response } from "express";

const RESERVED_RAW_HTML_PLACEHOLDERS = ["customer_signature", "employee_signature", "company_logo"] as const;

export function stripReservedRawHtmlPlaceholders(
  overrides: Record<string, string> | undefined
): Record<string, string> {
  const result: Record<string, string> = { ...(overrides ?? {}) };
  for (const reserved of RESERVED_RAW_HTML_PLACEHOLDERS) {
    if (reserved in result) {
      delete result[reserved];
    }
  }
  return result;
}

const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

function isValidSignatureDataUrl(value: string): boolean {
  if (value.length > 5 * 1024 * 1024) return false;
  const match = SIGNATURE_DATA_URL_RE.exec(value);
  if (!match) return false;
  const [, mime, b64] = match;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  if (mime === "png") {
    return decoded.length >= 8 &&
      decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47 &&
      decoded[4] === 0x0d && decoded[5] === 0x0a && decoded[6] === 0x1a && decoded[7] === 0x0a;
  }
  if (mime === "jpeg") {
    return decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
  }
  return false;
}

export function buildSignatureImg(value: string, alt: string, maxHeightPx: number): string {
  const safeAlt = escapeHtml(alt);
  if (!isValidSignatureDataUrl(value)) {
    return escapeHtml(value);
  }
  return `<img src="${value}" alt="${safeAlt}" style="max-height:${maxHeightPx}px;" />`;
}

function buildAuditStamp(options: {
  signingIp?: string | null;
  signingLocation?: string | null;
  integrityHash: string;
  signedAt: Date;
}): string {
  const { signingIp, signingLocation, integrityHash, signedAt } = options;
  const dateStr = signedAt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = signedAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const hashShort = integrityHash.substring(0, 16);

  const parts = [`Digital signiert am ${dateStr} um ${timeStr} Uhr`];
  if (signingIp) parts.push(`IP: ${signingIp}`);
  if (signingLocation) parts.push(`Standort: ${signingLocation}`);
  parts.push(`Hash: ${hashShort}...`);

  return `<div style="margin-top:40px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:8px;color:#999;font-family:monospace;line-height:1.4;">${parts.join(" | ")}</div>`;
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
  signingIp?: string | null;
  signingLocation?: string | null;
}): Promise<{
  objectPath: string;
  fileName: string;
  integrityHash: string;
  renderedHtml: string;
  generatedDocId: number;
}> {
  const { template, customerId, employeeId, customerSignatureData, employeeSignatureData, placeholderOverrides, generatedByUserId, signingStatus = "complete", signingIp, signingLocation } = options;

  const overrides = stripReservedRawHtmlPlaceholders(placeholderOverrides);
  if (customerSignatureData) {
    overrides.customer_signature = buildSignatureImg(customerSignatureData, "Kundenunterschrift", 240);
  }
  if (employeeSignatureData) {
    overrides.employee_signature = buildSignatureImg(employeeSignatureData, "Mitarbeiterunterschrift", 60);
  }

  let placeholders: Record<string, string>;
  if (customerId) {
    placeholders = await buildPlaceholders(customerId, overrides);
  } else {
    placeholders = { ...overrides };
  }

  const renderedHtml = renderTemplate(template.htmlContent, placeholders);

  const hasSigning = !!(customerSignatureData || employeeSignatureData);
  const now = new Date();

  const combinedHashForStamp = computeDataHash(
    JSON.stringify({
      customerSignature: customerSignatureData ? computeDataHash(customerSignatureData) : null,
      employeeSignature: employeeSignatureData ? computeDataHash(employeeSignatureData) : null,
      templateId: template.id,
      templateVersion: template.version,
    })
  );

  let htmlForPdf = renderedHtml;
  if (hasSigning) {
    const auditStamp = buildAuditStamp({
      signingIp,
      signingLocation,
      integrityHash: combinedHashForStamp,
      signedAt: now,
    });
    const isFullHtml = htmlForPdf.trim().toLowerCase().startsWith("<!doctype") || htmlForPdf.trim().toLowerCase().startsWith("<html");
    if (isFullHtml) {
      htmlForPdf = htmlForPdf.replace(/<\/body>/i, `${auditStamp}</body>`);
    } else {
      htmlForPdf = htmlForPdf + auditStamp;
    }
  }

  const { pdfBuffer, integrityHash } = await generatePdfFromHtml(htmlForPdf, template.name);

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
    signingIp: signingIp ?? null,
    signingLocation: signingLocation ?? null,
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
  signingIp?: string | null,
  signingLocation?: string | null,
): Promise<{ objectPath: string; fileName: string; integrityHash: string }> {
  if (!doc.renderedHtml) throw new Error("Kein gerendertetes HTML vorhanden");

  const sigHtml = buildSignatureImg(employeeSignatureData, "Mitarbeiterunterschrift", 60);
  let updatedHtml = doc.renderedHtml;
  if (updatedHtml.includes("{{employee_signature}}")) {
    updatedHtml = updatedHtml.replace(/\{\{employee_signature\}\}/g, sigHtml);
  } else {
    updatedHtml += `<div style="margin-top:40px;"><p><strong>Unterschrift Mitarbeiter:</strong></p>${sigHtml}<p style="font-size:10px;color:#666;">Datum: ${formatDateForDisplay(todayISO())}</p></div>`;
  }

  const stampHash = computeDataHash(
    JSON.stringify({
      customerSignature: doc.customerSignatureData ? computeDataHash(doc.customerSignatureData) : null,
      employeeSignature: computeDataHash(employeeSignatureData),
      templateId: doc.templateId,
      templateVersion: doc.templateVersion,
    })
  );
  const auditStamp = buildAuditStamp({
    signingIp,
    signingLocation,
    integrityHash: stampHash,
    signedAt: new Date(),
  });
  const isFullHtml = updatedHtml.trim().toLowerCase().startsWith("<!doctype") || updatedHtml.trim().toLowerCase().startsWith("<html");
  if (isFullHtml) {
    updatedHtml = updatedHtml.replace(/<\/body>/i, `${auditStamp}</body>`);
  } else {
    updatedHtml = updatedHtml + auditStamp;
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

export async function generateInfoDocumentPdfs(options: {
  customerId: number;
  billingType: string;
  generatedByUserId: number;
}): Promise<void> {
  const { customerId, billingType, generatedByUserId } = options;

  try {
    const { evaluateTriggersForCustomer } = await import("./document-trigger-engine");
    const requirements = await evaluateTriggersForCustomer({ billingType });

    const infoRequirements = requirements.filter(
      r => r.documentType.inputMethod === "info" && r.template
    );

    for (const req of infoRequirements) {
      if (!req.template) continue;

      try {
        const template = await documentStorage.getDocumentTemplate(req.template.id);
        if (!template) continue;

        await generateAndStorePdf({
          template,
          customerId,
          generatedByUserId,
          signingStatus: "complete",
        });
      } catch (err) {
        console.error(`[info-docs] PDF-Generierung fehlgeschlagen für Dokumententyp ${req.documentType.name} (Kunde ${customerId}):`, err);
      }
    }
  } catch (err) {
    console.error(`[info-docs] Info-Dokument-Generierung fehlgeschlagen für Kunde ${customerId}:`, err);
  }
}

export async function getDocumentPdfBuffer(objectPath: string): Promise<Buffer> {
  let fullPath: string;
  if (objectPath.startsWith("/objects/")) {
    const normalized = path.posix.normalize(objectPath);
    if (!normalized.startsWith("/objects/") || normalized.includes("..")) {
      throw badRequest("Ungültiger Objekt-Pfad");
    }
    const entityId = normalized.slice("/objects/".length);
    if (!entityId || entityId.startsWith("/")) {
      throw badRequest("Ungültiger Objekt-Pfad");
    }
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

function generateSigningToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSigningLinkAndRespond(
  req: Request,
  res: Response,
  result: { generatedDocId: number; fileName: string; objectPath: string; integrityHash: string },
  signingStatus: string,
  deferEmployeeSignature: boolean,
): Promise<void> {
  let signingLink: string | null = null;

  if (deferEmployeeSignature) {
    const rawToken = generateSigningToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await documentStorage.createSigningToken(result.generatedDocId, tokenHash, expiresAt);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    signingLink = `${baseUrl}/unterschreiben/${rawToken}`;
  }

  res.status(201).json({
    id: result.generatedDocId,
    fileName: result.fileName,
    objectPath: result.objectPath,
    integrityHash: result.integrityHash,
    signingStatus,
    signingLink,
  });
}
