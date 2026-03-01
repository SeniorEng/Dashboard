import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { documentStorage } from "../../storage/documents";
import { insertDocumentTypeSchema, updateDocumentTypeSchema, insertEmployeeDocumentSchema, insertCustomerDocumentSchema, insertDocumentTemplateSchema, updateDocumentTemplateSchema } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { renderTemplateForCustomer, renderTemplateFromFormData, wrapInPrintableHtml, getPlaceholderCatalog, type WizardFormData } from "../../services/template-engine";
import { generateAndStorePdf, getDocumentPdfBuffer } from "../../services/document-pdf";

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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  const result = updateDocumentTypeSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const docType = await documentStorage.updateDocumentType(id, result.data);
  if (!docType) { res.status(404).json({ error: "NOT_FOUND", message: "Dokumententyp nicht gefunden" }); return; }
  res.json(docType);
}));

router.get("/employees/:employeeId/documents", asyncHandler("Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Mitarbeiter-ID" }); return; }
  const docs = await documentStorage.getCurrentDocuments(employeeId);
  res.json(docs);
}));

router.get("/employees/:employeeId/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  const documentTypeId = parseInt(req.params.documentTypeId);
  if (isNaN(employeeId) || isNaN(documentTypeId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }
  const docs = await documentStorage.getDocumentHistory(employeeId, documentTypeId);
  res.json(docs);
}));

router.post("/employees/:employeeId/documents", asyncHandler("Dokument konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Mitarbeiter-ID" }); return; }

  const data = { ...req.body, employeeId };
  const result = insertEmployeeDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const userId = req.user!.id;
  const doc = await documentStorage.uploadDocument(result.data, userId);
  res.status(201).json(doc);
}));

router.get("/customers/:customerId/documents", asyncHandler("Kundendokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }
  const docs = await documentStorage.getCurrentCustomerDocuments(customerId);
  res.json(docs);
}));

router.get("/customers/:customerId/documents/:documentTypeId/history", asyncHandler("Dokumentenhistorie konnte nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  const documentTypeId = parseInt(req.params.documentTypeId);
  if (isNaN(customerId) || isNaN(documentTypeId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }
  const docs = await documentStorage.getCustomerDocumentHistory(customerId, documentTypeId);
  res.json(docs);
}));

router.post("/customers/:customerId/documents", asyncHandler("Kundendokument konnte nicht hochgeladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  const data = { ...req.body, customerId };
  const result = insertCustomerDocumentSchema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }

  const userId = req.user!.id;
  const doc = await documentStorage.uploadCustomerDocument(result.data, userId);
  res.status(201).json(doc);
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

router.get("/document-templates/billing-type/:billingType", asyncHandler("Vorlagen für Kundentyp konnten nicht geladen werden", async (req: Request, res: Response) => {
  const validTypes = ["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"];
  if (!validTypes.includes(req.params.billingType)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültiger Kundentyp" });
    return;
  }
  const templates = await documentStorage.getTemplatesForBillingType(req.params.billingType);
  res.json(templates);
}));

const renderTemplateSchema = z.object({
  templateSlug: z.string().min(1),
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
  templateSlug: z.string().min(1),
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  const result = updateDocumentTemplateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: result.error.issues });
    return;
  }
  const template = await documentStorage.updateDocumentTemplate(id, result.data);
  if (!template) { res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" }); return; }
  res.json(template);
}));

router.get("/document-templates/:id/billing-types", asyncHandler("Abrechnungsarten konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }
  const billingTypes = await documentStorage.getTemplateBillingTypes(id);
  res.json(billingTypes);
}));

const billingTypeAssignmentSchema = z.object({
  assignments: z.array(z.object({
    billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]),
    requirement: z.enum(["pflicht", "optional"]),
    sortOrder: z.number().int().min(0),
  })),
});

router.put("/document-templates/:id/billing-types", asyncHandler("Abrechnungsarten konnten nicht gespeichert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  const template = await documentStorage.getDocumentTemplate(id);
  if (!template) { res.status(404).json({ error: "NOT_FOUND", message: "Vorlage nicht gefunden" }); return; }

  const parsed = billingTypeAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Daten", details: parsed.error.issues });
    return;
  }

  const result = await documentStorage.setTemplateBillingTypes(id, parsed.data.assignments);
  res.json(result);
}));

router.get("/document-templates-billing-types/all", asyncHandler("Alle Abrechnungsarten-Zuordnungen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const all = await documentStorage.getAllTemplateBillingTypes();
  res.json(all);
}));

router.get("/customers/:customerId/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }
  const docs = await documentStorage.getGeneratedDocuments(customerId);
  res.json(docs);
}));

router.get("/employees/:employeeId/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Mitarbeiter-ID" }); return; }
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

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

export default router;
