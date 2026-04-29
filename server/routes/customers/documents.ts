import { Router } from "express";
import { z } from "zod";
import { documentStorage } from "../../storage/documents";
import { renderTemplateForCustomer, wrapInPrintableHtml, extractInputPlaceholders } from "../../services/template-engine";
import { generateAndStorePdf, getDocumentPdfBuffer, createSigningLinkAndRespond } from "../../services/document-pdf";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam, requireCustomerAccess } from "../../lib/params";

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
  const docId = requireIntParam(req.params.docId, res);
  if (docId === null) return;

  const doc = await documentStorage.getGeneratedDocument(docId);
  if (!doc) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dokument nicht gefunden" });
    return;
  }

  if (doc.customerId) {
    if (!await requireCustomerAccess(req, res, doc.customerId)) return;
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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

  const docs = await documentStorage.getCurrentCustomerDocuments(customerId);
  res.json(docs);
}));

router.get("/:id/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  const documentTypeId = requireIntParam(req.params.documentTypeId, res);
  if (customerId === null || documentTypeId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

  const docs = await documentStorage.getCustomerDocumentHistory(customerId, documentTypeId);
  res.json(docs);
}));

router.post("/:id/documents", asyncHandler("Kundendokument konnte nicht hochgeladen werden", async (req, res) => {
  const user = req.user!;
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

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

  await createSigningLinkAndRespond(req, res, result, signingStatus, deferEmployeeSignature);
}));

router.get("/:id/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req, res) => {
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;
  if (!await requireCustomerAccess(req, res, customerId)) return;

  const docs = await documentStorage.getGeneratedDocuments(customerId);
  res.json(docs);
}));

export default router;
