import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { documentStorage } from "../../storage/documents";
import { insertDocumentTypeSchema, updateDocumentTypeSchema, insertEmployeeDocumentSchema, insertCustomerDocumentSchema, insertDocumentTemplateSchema, updateDocumentTemplateSchema, insertDocumentTypeTriggerSchema } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam } from "../../lib/params";
import { renderTemplateForCustomer, renderTemplateFromFormData, wrapInPrintableHtml, getPlaceholderCatalog, type WizardFormData } from "../../services/template-engine";
import { generateAndStorePdf, getDocumentPdfBuffer } from "../../services/document-pdf";
import { evaluateTriggersForCustomer, evaluateTriggersForEmployee } from "../../services/document-trigger-engine";

const router = Router();

router.get("/document-types", asyncHandler("Dokumententypen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const includeInactive = _req.query.includeInactive === "true";
  const targetType = _req.query.targetType as string | undefined;
  const types = await documentStorage.getDocumentTypesWithTemplateInfo(!includeInactive, targetType);
  res.json(types);
}));

router.post("/document-types", asyncHandler("Dokumententyp konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const result = insertDocumentTypeSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const docType = await documentStorage.createDocumentType(result.data);
  res.status(201).json(docType);
}));

router.patch("/document-types/:id", asyncHandler("Dokumententyp konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const result = updateDocumentTypeSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const docType = await documentStorage.updateDocumentType(id, result.data);
  if (!docType) { res.status(404).json({ error: "NOT_FOUND", message: "Dokumententyp nicht gefunden" }); return; }
  res.json(docType);
}));

router.get("/document-types/:id/triggers", asyncHandler("Trigger konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const triggers = await documentStorage.getTriggersForDocumentType(id);
  res.json(triggers);
}));

const upsertTriggersSchema = z.object({
  triggers: z.array(insertDocumentTypeTriggerSchema.omit({ documentTypeId: true })),
});

router.put("/document-types/:id/triggers", asyncHandler("Trigger konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const docType = await documentStorage.getDocumentType(id);
  if (!docType) { res.status(404).json({ error: "NOT_FOUND", message: "Dokumententyp nicht gefunden" }); return; }

  const result = upsertTriggersSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const triggersWithDocTypeId = result.data.triggers.map((t) => ({
    ...t,
    documentTypeId: id,
    entityType: t.entityType ?? docType.targetType,
  }));

  const saved = await documentStorage.upsertTriggers(id, triggersWithDocTypeId);
  res.json(saved);
}));

router.get("/document-requirements/customer/:billingType", asyncHandler("Dokumentenanforderungen konnten nicht ermittelt werden", async (req: Request, res: Response) => {
  const billingType = req.params.billingType;
  const requirements = await evaluateTriggersForCustomer({ billingType });
  res.json(requirements);
}));

router.get("/document-requirements/employee/:employeeId", asyncHandler("Dokumentenanforderungen konnten nicht ermittelt werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  if (employeeId === null) return;

  const { db: dbInstance } = await import("../../lib/db");
  const { users, userRoles } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");

  const [employee] = await dbInstance.select().from(users).where(eq(users.id, employeeId)).limit(1);
  if (!employee) { res.status(404).json({ error: "NOT_FOUND", message: "Mitarbeiter nicht gefunden" }); return; }

  const roles = await dbInstance.select().from(userRoles).where(eq(userRoles.userId, employeeId));
  const roleNames = roles.map((r) => r.role);

  const requirements = await evaluateTriggersForEmployee({
    roles: roleNames,
    employmentType: employee.employmentType ?? undefined,
    haustierAkzeptiert: employee.haustierAkzeptiert ?? undefined,
  });
  res.json(requirements);
}));

router.get("/employees/:employeeId/documents", asyncHandler("Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  if (employeeId === null) return;
  const grouped = req.query.grouped === "true";
  if (grouped) {
    const docs = await documentStorage.getGroupedDocuments(employeeId);
    res.json(docs);
  } else {
    const docs = await documentStorage.getCurrentDocuments(employeeId);
    res.json(docs);
  }
}));

router.get("/employees/:employeeId/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  const documentTypeId = requireIntParam(req.params.documentTypeId, res);
  if (employeeId === null || documentTypeId === null) return;
  const docs = await documentStorage.getDocumentHistory(employeeId, documentTypeId);
  res.json(docs);
}));

router.post("/employees/:employeeId/documents", asyncHandler("Dokument konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  if (employeeId === null) return;

  const data = { ...req.body, employeeId };
  const result = insertEmployeeDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const userId = req.user!.id;
  const skipDeactivation = req.body.skipDeactivation === true;
  const batchId = typeof req.body.batchId === "string" ? req.body.batchId : undefined;
  const batchLabel = typeof req.body.batchLabel === "string" ? req.body.batchLabel : undefined;
  const documentDate = typeof req.body.documentDate === "string" && req.body.documentDate ? req.body.documentDate : undefined;
  const doc = await documentStorage.uploadDocument(result.data, userId, { skipDeactivation, batchId, batchLabel, documentDate });
  res.status(201).json(doc);
}));

router.delete("/employees/:employeeId/documents/batch/:batchId", asyncHandler("Batch konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const { batchId } = req.params;
  if (!batchId) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Batch-ID" }); return; }
  const count = await documentStorage.softDeleteBatch(batchId);
  res.json({ success: true, deletedCount: count });
}));

router.delete("/employees/:employeeId/documents/:documentId", asyncHandler("Dokument konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const documentId = requireIntParam(req.params.documentId, res);
  if (documentId === null) return;
  await documentStorage.softDeleteDocument(documentId);
  res.json({ success: true });
}));

router.get("/customers/:customerId/documents", asyncHandler("Kundendokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const grouped = req.query.grouped === "true";
  if (grouped) {
    const docs = await documentStorage.getGroupedCustomerDocuments(customerId);
    res.json(docs);
  } else {
    const docs = await documentStorage.getCurrentCustomerDocuments(customerId);
    res.json(docs);
  }
}));

router.get("/customers/:customerId/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  const documentTypeId = requireIntParam(req.params.documentTypeId, res);
  if (customerId === null || documentTypeId === null) return;
  const docs = await documentStorage.getCustomerDocumentHistory(customerId, documentTypeId);
  res.json(docs);
}));

router.post("/customers/:customerId/documents", asyncHandler("Kundendokument konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;

  const data = { ...req.body, customerId };
  const result = insertCustomerDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const userId = req.user!.id;
  const skipDeactivation = req.body.skipDeactivation === true;
  const batchId = typeof req.body.batchId === "string" ? req.body.batchId : undefined;
  const batchLabel = typeof req.body.batchLabel === "string" ? req.body.batchLabel : undefined;
  const documentDate = typeof req.body.documentDate === "string" && req.body.documentDate ? req.body.documentDate : undefined;
  const doc = await documentStorage.uploadCustomerDocument(result.data, userId, { skipDeactivation, batchId, batchLabel, documentDate });
  res.status(201).json(doc);
}));

router.delete("/customers/:customerId/documents/batch/:batchId", asyncHandler("Kunden-Batch konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const { batchId } = req.params;
  if (!batchId) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Batch-ID" }); return; }
  const count = await documentStorage.softDeleteCustomerBatch(batchId);
  res.json({ success: true, deletedCount: count });
}));

router.delete("/customers/:customerId/documents/:documentId", asyncHandler("Kundendokument konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const documentId = requireIntParam(req.params.documentId, res);
  if (documentId === null) return;
  await documentStorage.softDeleteCustomerDocument(documentId);
  res.json({ success: true });
}));

router.get("/documents/due-soon", asyncHandler("Fällige Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 60;
  const [employeeDocs, customerDocs] = await Promise.all([
    documentStorage.getEmployeeDocumentsDueSoon(days),
    documentStorage.getCustomerDocumentsDueSoon(days),
  ]);
  res.json({ employee: employeeDocs, customer: customerDocs });
}));

router.get("/document-templates", asyncHandler("Dokumentenvorlagen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const includeInactive = req.query.includeInactive === "true";
  const templates = await documentStorage.getDocumentTemplates(!includeInactive);
  res.json(templates);
}));

router.get("/document-templates/placeholders/catalog", asyncHandler("Platzhalter-Katalog konnte nicht geladen werden", async (_req: Request, res: Response) => {
  res.json(getPlaceholderCatalog());
}));

const renderTemplateSchema = z.object({
  templateSlug: z.string().min(1, "Template-Slug ist erforderlich"),
  customerId: z.number().int(),
  overrides: z.record(z.string()).optional(),
});

router.post("/document-templates/render", asyncHandler("Vorlage konnte nicht gerendert werden", async (req: Request, res: Response) => {
  const parsed = renderTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "templateSlug und customerId sind erforderlich", details: parsed.error.issues });
    return;
  }

  const { templateSlug, customerId, overrides } = parsed.data;
  const result = await renderTemplateForCustomer(templateSlug, customerId, overrides || {});
  const printableHtml = wrapInPrintableHtml(result.html, templateSlug);

  res.json({
    html: result.html,
    printableHtml,
    templateId: result.templateId,
    templateVersion: result.templateVersion,
  });
}));

const renderPreviewSchema = z.object({
  templateSlug: z.string().min(1, "Template-Slug ist erforderlich"),
  formData: z.object({
    vorname: z.string(),
    nachname: z.string(),
    geburtsdatum: z.string().optional(),
    email: z.string().optional(),
    telefon: z.string().optional(),
    festnetz: z.string().optional(),
    strasse: z.string().optional(),
    nr: z.string().optional(),
    plz: z.string().optional(),
    stadt: z.string().optional(),
    pflegegrad: z.string().optional(),
    billingType: z.string().optional(),
    vorerkrankungen: z.string().optional(),
    haustierVorhanden: z.boolean().optional(),
    haustierDetails: z.string().optional(),
    personenbefoerderungGewuenscht: z.boolean().optional(),
    versichertennummer: z.string().optional(),
    contractDate: z.string().optional(),
    contractStart: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    contractHours: z.string().optional(),
    contractPeriod: z.string().optional(),
    contacts: z.array(z.object({
      vorname: z.string().optional(),
      nachname: z.string().optional(),
      contactType: z.string().optional(),
      telefon: z.string().optional(),
      email: z.string().optional(),
      isPrimary: z.boolean().optional(),
    })).optional(),
    insuranceProviderId: z.string().optional(),
  }),
  overrides: z.record(z.string()).optional(),
});

router.post("/document-templates/render-preview", asyncHandler("Vorschau konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const parsed = renderPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "templateSlug und formData sind erforderlich", details: parsed.error.issues });
    return;
  }

  const { templateSlug, formData, overrides } = parsed.data;
  const result = await renderTemplateFromFormData(templateSlug, formData as WizardFormData, overrides || {});
  const printableHtml = wrapInPrintableHtml(result.html, templateSlug);

  res.json({
    html: result.html,
    printableHtml,
    templateId: result.templateId,
    templateVersion: result.templateVersion,
  });
}));

router.get("/document-templates/:id", asyncHandler("Dokumentenvorlage konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const template = await documentStorage.getDocumentTemplate(id);
  if (!template) { res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" }); return; }
  res.json(template);
}));

router.post("/document-templates", asyncHandler("Dokumentenvorlage konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const result = insertDocumentTemplateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const template = await documentStorage.createDocumentTemplate(result.data);
  res.status(201).json(template);
}));

router.patch("/document-templates/:id", asyncHandler("Dokumentenvorlage konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const result = updateDocumentTemplateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const template = await documentStorage.updateDocumentTemplate(id, result.data);
  if (!template) { res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" }); return; }
  res.json(template);
}));

router.get("/customers/:customerId/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = requireIntParam(req.params.customerId, res);
  if (customerId === null) return;
  const docs = await documentStorage.getGeneratedDocuments(customerId);
  res.json(docs);
}));

router.get("/employees/:employeeId/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  if (employeeId === null) return;
  const docs = await documentStorage.getGeneratedDocumentsByEmployee(employeeId);
  res.json(docs);
}));

const generateDocumentSchema = z.object({
  templateId: z.number().int(),
  customerId: z.number().int().nullable().optional(),
  employeeId: z.number().int().nullable().optional(),
  customerSignatureData: z.string().nullable().optional(),
  employeeSignatureData: z.string().nullable().optional(),
  placeholderOverrides: z.record(z.string()).optional(),
  deferEmployeeSignature: z.boolean().optional().default(false),
  signingLocation: z.string().nullable().optional(),
});

function generateSigningToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.post("/documents/generate-pdf", asyncHandler("PDF konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const parsed = generateDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: parsed.error.issues });
    return;
  }

  const { templateId, customerId, employeeId, customerSignatureData, employeeSignatureData, placeholderOverrides, deferEmployeeSignature, signingLocation } = parsed.data;
  const signingIp = req.ip || req.socket.remoteAddress || null;

  if (!customerId && !employeeId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Entweder customerId oder employeeId ist erforderlich" });
    return;
  }

  const template = await documentStorage.getDocumentTemplate(templateId);
  if (!template) {
    res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" });
    return;
  }

  const signingStatus = deferEmployeeSignature ? "pending_employee_signature" as const : "complete" as const;

  const result = await generateAndStorePdf({
    template,
    customerId: customerId ?? undefined,
    employeeId: employeeId ?? undefined,
    customerSignatureData,
    employeeSignatureData: deferEmployeeSignature ? null : employeeSignatureData,
    placeholderOverrides,
    generatedByUserId: req.user!.id,
    signingStatus,
    signingIp,
    signingLocation,
  });

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
}));

router.get("/generated-documents/:id/download", asyncHandler("PDF konnte nicht heruntergeladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const doc = await documentStorage.getGeneratedDocument(id);
  if (!doc) {
    res.status(404).json({ error: "NOT_FOUND", message: "Dokument nicht gefunden" });
    return;
  }

  const pdfBuffer = await getDocumentPdfBuffer(doc.objectPath);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.send(pdfBuffer);
}));

router.get("/document-templates/by-context", asyncHandler("Vorlagen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const context = (req.query.context as string) || "alle";
  const targetType = (req.query.targetType as string) || "beide";
  const templates = await documentStorage.getTemplatesByContext(context, targetType);
  res.json(templates);
}));

router.get("/employee/:employeeId/proofs", asyncHandler("Nachweise konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = requireIntParam(req.params.employeeId, res);
  if (employeeId === null) return;
  const proofs = await documentStorage.getEmployeeProofs(employeeId);
  res.json(proofs);
}));

router.get("/proofs/pending-review", asyncHandler("Ausstehende Prüfungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const proofs = await documentStorage.getPendingReviewProofs();
  res.json(proofs);
}));

router.patch("/proofs/:proofId/upload", asyncHandler("Nachweis konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const proofId = requireIntParam(req.params.proofId, res);
  if (proofId === null) return;

  const proof = await documentStorage.getProofById(proofId);
  if (!proof) { res.status(404).json({ error: "Nachweis nicht gefunden" }); return; }

  if (proof.status !== "pending" && proof.status !== "rejected") {
    res.status(400).json({ error: "Nachweis kann in diesem Status nicht hochgeladen werden" });
    return;
  }

  const uploadSchema = z.object({ fileName: z.string().min(1, "Dateiname ist erforderlich"), objectPath: z.string().min(1, "Dateipfad ist erforderlich") });
  const result = uploadSchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ error: "Ungültige Daten" }); return; }

  const updated = await documentStorage.uploadProof(proofId, result.data.fileName, result.data.objectPath);
  res.json(updated);
}));

router.patch("/proofs/:proofId/review", asyncHandler("Prüfung konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const proofId = requireIntParam(req.params.proofId, res);
  if (proofId === null) return;

  const existing = await documentStorage.getProofById(proofId);
  if (!existing) { res.status(404).json({ error: "Nachweis nicht gefunden" }); return; }
  if (existing.status !== "uploaded") { res.status(400).json({ error: "Nachweis ist nicht im Status 'Hochgeladen'" }); return; }

  const reviewSchema = z.object({
    approved: z.boolean(),
    rejectionReason: z.string().max(500, "Maximal 500 Zeichen erlaubt").optional(),
  });
  const result = reviewSchema.safeParse(req.body);
  if (!result.success) { res.status(400).json({ error: "Validierungsfehler" }); return; }

  const proof = await documentStorage.reviewProof(proofId, result.data.approved, req.user!.id, result.data.rejectionReason);
  if (!proof) { res.status(404).json({ error: "Nachweis nicht gefunden" }); return; }
  res.json(proof);
}));

export default router;
