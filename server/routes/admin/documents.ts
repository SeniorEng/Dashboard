import { Router, Request, Response } from "express";
import { z } from "zod";
import { documentStorage } from "../../storage/documents";
import { insertDocumentTypeSchema, updateDocumentTypeSchema, insertEmployeeDocumentSchema, insertCustomerDocumentSchema, insertDocumentTemplateSchema, updateDocumentTemplateSchema } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { renderTemplateForCustomer, wrapInPrintableHtml, getPlaceholderCatalog } from "../../services/template-engine";

const router = Router();

router.get("/document-types", asyncHandler("Dokumententypen konnten nicht geladen werden", async (_req: Request, res: Response) => {
  const includeInactive = _req.query.includeInactive === "true";
  const targetType = _req.query.targetType as string | undefined;
  const types = await documentStorage.getDocumentTypes(!includeInactive, targetType);
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

router.get("/customers/:customerId/generated-documents", asyncHandler("Generierte Dokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const customerId = parseInt(req.params.customerId);
  if (isNaN(customerId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }
  const docs = await documentStorage.getGeneratedDocuments(customerId);
  res.json(docs);
}));

export default router;
