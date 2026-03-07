import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { storage } from "../../storage";
import { documentStorage } from "../../storage/documents";
import { renderTemplateForCustomer, wrapInPrintableHtml, extractInputPlaceholders } from "../../services/template-engine";
import { generateAndStorePdf, getDocumentPdfBuffer } from "../../services/document-pdf";
import { asyncHandler } from "../../lib/errors";

const router = Router();

router.get("/document-types/customer", asyncHandler("Dokumententypen konnten nicht geladen werden", async (req, res) => {
  const context = req.query.context as string | undefined;
  const types = await documentStorage.getDocumentTypesWithTemplateInfo(true, "customer");
  if (context && context !== "alle") {
    const filtered = types.filter(t => t.context === context || t.context === "beide");
    res.json(filtered);
    return;
  }
  res.json(types);
}));

router.get("/generated-documents/:docId/download", asyncHandler("PDF konnte nicht heruntergeladen werden", async (req, res) => {
  const user = req.user!;
  const docId = parseInt(req.params.docId);
  if (isNaN(docId)) { res.status(400).json({ error: "Ungültige ID" }); return; }

  const doc = await documentStorage.getGeneratedDocument(docId);
  if (!doc) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dokument nicht gefunden" });
    return;
  }

  if (doc.customerId && !user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(doc.customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const pdfBuffer = await getDocumentPdfBuffer(doc.objectPath);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.send(pdfBuffer);
}));

router.get("/document-requirements/:billingType", asyncHandler("Dokumentenanforderungen konnten nicht ermittelt werden", async (req, res) => {
  const { evaluateTriggersForCustomer } = await import("../../services/document-trigger-engine");
  const billingType = req.params.billingType;
  const requirements = await evaluateTriggersForCustomer({ billingType });
  res.json(requirements);
}));

router.get("/:id/documents", asyncHandler("Kundendokumente konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const docs = await documentStorage.getCurrentCustomerDocuments(customerId);
  res.json(docs);
}));

router.get("/:id/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  const documentTypeId = parseInt(req.params.documentTypeId);
  if (isNaN(customerId) || isNaN(documentTypeId)) { res.status(400).json({ error: "Ungültige ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const docs = await documentStorage.getCustomerDocumentHistory(customerId, documentTypeId);
  res.json(docs);
}));

router.post("/:id/documents", asyncHandler("Kundendokument konnte nicht hochgeladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const { insertCustomerDocumentSchema } = await import("@shared/schema");
  const data = { ...req.body, customerId };
  const result = insertCustomerDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const documentDate = typeof req.body.documentDate === "string" && req.body.documentDate ? req.body.documentDate : undefined;
  const doc = await documentStorage.uploadCustomerDocument(result.data, user.id, { documentDate });
  res.status(201).json(doc);
}));

router.get("/:id/document-templates", asyncHandler("Vorlagen konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const templates = await documentStorage.getTemplatesByContext("bestandskunde", "customer");
  const templatesWithInputFields = templates.map(t => ({
    ...t,
    inputFields: extractInputPlaceholders(t.htmlContent),
  }));
  res.json(templatesWithInputFields);
}));

const renderSchema = z.object({
  templateSlug: z.string().min(1),
  overrides: z.record(z.string()).optional(),
});

router.post("/:id/document-templates/render", asyncHandler("Vorlage konnte nicht gerendert werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const parsed = renderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "templateSlug ist erforderlich", details: parsed.error.issues });
    return;
  }

  const result = await renderTemplateForCustomer(parsed.data.templateSlug, customerId, parsed.data.overrides || {});
  const printableHtml = wrapInPrintableHtml(result.html, parsed.data.templateSlug);

  res.json({
    html: result.html,
    printableHtml,
    templateId: result.templateId,
    templateVersion: result.templateVersion,
  });
}));

const generatePdfSchema = z.object({
  templateId: z.number().int(),
  customerSignatureData: z.string().nullable().optional(),
  employeeSignatureData: z.string().nullable().optional(),
  placeholderOverrides: z.record(z.string()).optional(),
  deferEmployeeSignature: z.boolean().optional().default(false),
  signingLocation: z.string().nullable().optional(),
});

router.post("/:id/documents/generate-pdf", asyncHandler("PDF konnte nicht erstellt werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const parsed = generatePdfSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: parsed.error.issues });
    return;
  }

  const { templateId, customerSignatureData, employeeSignatureData, placeholderOverrides, deferEmployeeSignature, signingLocation } = parsed.data;
  const signingIp = req.ip || req.socket.remoteAddress || null;

  const template = await documentStorage.getDocumentTemplate(templateId);
  if (!template) {
    res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" });
    return;
  }

  const signingStatus = deferEmployeeSignature ? "pending_employee_signature" as const : "complete" as const;

  const result = await generateAndStorePdf({
    template,
    customerId,
    customerSignatureData,
    employeeSignatureData: deferEmployeeSignature ? null : employeeSignatureData,
    placeholderOverrides,
    generatedByUserId: user.id,
    signingStatus,
    signingIp,
    signingLocation,
  });

  let signingLink: string | null = null;

  if (deferEmployeeSignature) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
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
}));

router.get("/:id/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) { res.status(400).json({ error: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) {
      return res.status(403).json({ error: "Zugriff verweigert" });
    }
  }

  const docs = await documentStorage.getGeneratedDocuments(customerId);
  res.json(docs);
}));

export default router;
