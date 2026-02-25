import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCustomerSchema, insertCustomerContactSchema } from "@shared/schema";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth";
import { birthdaysCache, customerIdsCache } from "../services/cache";
import { documentStorage } from "../storage/documents";
import { BILLING_TYPES } from "@shared/domain/customers";
import { isPflegekasseCustomer } from "@shared/domain/customers";
import { renderTemplateForCustomer, wrapInPrintableHtml, extractInputPlaceholders } from "../services/template-engine";
import { generateAndStorePdf, getDocumentPdfBuffer } from "../services/document-pdf";
import { computeDataHash } from "../services/signature-integrity";
import crypto from "crypto";
import { customerManagementStorage } from "../storage/customer-management";
import { asyncHandler, forbidden } from "../lib/errors";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { insertCustomerServicePriceSchema, customers } from "@shared/schema";
import { auditService } from "../services/audit";

const billingTypeEnum = z.enum(BILLING_TYPES as unknown as [string, ...string[]]);

const router = Router();

router.use(requireAuth);

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

router.get("/document-templates/billing-type/:billingType", asyncHandler("Vorlagen konnten nicht geladen werden", async (req, res) => {
  const parsed = billingTypeEnum.safeParse(req.params.billingType);
  if (!parsed.success) {
    res.status(400).json({ error: "Ungültiger Kundentyp" });
    return;
  }
  const templates = await documentStorage.getTemplatesForBillingType(parsed.data);
  res.json(templates);
}));

router.get("/", asyncHandler("Kunden konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const statusFilter = req.query.status as string | undefined;
  
  if (user.isAdmin) {
    let allCustomers = await storage.getCustomers();
    if (statusFilter) {
      allCustomers = allCustomers.filter(c => c.status === statusFilter);
    }
    res.json(allCustomers);
    return;
  }
  
  let customersWithAccess = await storage.getCustomersForEmployee(user.id);
  if (statusFilter) {
    customersWithAccess = customersWithAccess.filter(c => c.status === statusFilter);
  }
  res.json(customersWithAccess);
}));

router.get("/:id", asyncHandler("Kunde konnte nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige Kunden-ID" });
    return;
  }
  
  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "Zugriff verweigert" });
      return;
    }
  }
  
  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "Kunde nicht gefunden" });
    return;
  }
  res.json(customer);
}));

router.get("/:id/details", asyncHandler("Kundendetails konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Ungültige Kunden-ID" });
    return;
  }
  
  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "Zugriff verweigert" });
      return;
    }
  }
  
  const [contacts, insurance, contract] = await Promise.all([
    customerManagementStorage.getCustomerContacts(id),
    customerManagementStorage.getCustomerCurrentInsurance(id),
    customerManagementStorage.getCustomerCurrentContract(id),
  ]);
  
  res.json({
    contacts,
    insurance: insurance ? {
      providerName: insurance.provider?.name || "Unbekannt",
      ikNummer: insurance.provider?.ikNummer || undefined,
      versichertennummer: insurance.versichertennummer,
    } : null,
    contract: contract ? {
      vereinbarteLeistungen: contract.vereinbarteLeistungen,
      contractStart: contract.contractStart,
      status: contract.status,
    } : null,
  });
}));

const employeeUpdateCustomerSchema = z.object({
  strasse: z.string().min(1).max(200).optional(),
  nr: z.string().min(1).max(20).optional(),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5-stellig sein").optional(),
  stadt: z.string().min(1).max(100).optional(),
  telefon: z.string().max(30).nullable().optional(),
  festnetz: z.string().max(30).nullable().optional(),
  email: z.string().email("Ungültige E-Mail-Adresse").nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).nullable().optional(),
  vorerkrankungen: z.string().max(2000).nullable().optional(),
});

router.patch("/:id", asyncHandler("Kundendaten konnten nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!user.isAdmin && !assignedCustomerIds.includes(id)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return;
  }

  const customer = await storage.getCustomer(id);
  if (!customer) { res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" }); return; }

  const data = employeeUpdateCustomerSchema.parse(req.body);

  const changedFields: string[] = [];
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const oldVal = (customer as Record<string, unknown>)[key];
    if (oldVal !== value) {
      changedFields.push(key);
      oldValues[key] = oldVal;
      newValues[key] = value;
    }
  }

  if (changedFields.length === 0) {
    res.json(customer);
    return;
  }

  const updated = await customerManagementStorage.updateCustomer(id, data);

  await auditService.customerUpdated(user.id, id, { changedFields, oldValues, newValues }, req.ip);

  res.json(updated);
}));

const employeeCareLevelSchema = z.object({
  pflegegrad: z.number().int().min(1).max(5),
  seitDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein"),
});

router.post("/:id/care-level", asyncHandler("Pflegegrad konnte nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!user.isAdmin && !assignedCustomerIds.includes(id)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return;
  }

  const customer = await storage.getCustomer(id);
  if (!customer) { res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" }); return; }

  const { pflegegrad, seitDatum } = employeeCareLevelSchema.parse(req.body);

  const oldPflegegrad = customer.pflegegrad;

  await customerManagementStorage.addCareLevelHistory({
    customerId: id,
    pflegegrad,
    validFrom: seitDatum,
  }, user.id);

  await auditService.customerCareLevelChanged(user.id, id, {
    oldPflegegrad,
    newPflegegrad: pflegegrad,
    seitDatum,
  }, req.ip);

  const updated = await storage.getCustomer(id);
  res.json(updated);
}));

const employeeContractUpdateSchema = z.object({
  vereinbarteLeistungen: z.string().max(2000).nullable(),
});

router.patch("/:id/contract", asyncHandler("Vertragsdaten konnten nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
  if (!user.isAdmin && !assignedCustomerIds.includes(id)) {
    res.status(403).json({ error: "Zugriff verweigert" });
    return;
  }

  const contract = await customerManagementStorage.getCustomerCurrentContract(id);
  if (!contract) { res.status(404).json({ error: "NOT_FOUND", message: "Kein aktiver Vertrag gefunden" }); return; }

  const { vereinbarteLeistungen } = employeeContractUpdateSchema.parse(req.body);

  const oldValue = contract.vereinbarteLeistungen;
  if (oldValue === vereinbarteLeistungen) {
    res.json({ vereinbarteLeistungen: contract.vereinbarteLeistungen });
    return;
  }

  await customerManagementStorage.updateCustomerContract(contract.id, { vereinbarteLeistungen });

  await auditService.customerContractUpdated(user.id, id, {
    changedFields: ["vereinbarteLeistungen"],
    oldValues: { vereinbarteLeistungen: oldValue },
    newValues: { vereinbarteLeistungen },
  }, req.ip);

  res.json({ vereinbarteLeistungen });
}));

const employeeContactUpdateSchema = insertCustomerContactSchema
  .omit({ customerId: true })
  .partial();

router.get("/:id/contacts", asyncHandler("Kontakte konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const contacts = await customerManagementStorage.getCustomerContacts(id);
  res.json(contacts);
}));

router.post("/:id/contacts", asyncHandler("Kontakt konnte nicht hinzugefügt werden", async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(id)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const validatedData = insertCustomerContactSchema.parse({ ...req.body, customerId: id });
  const contact = await customerManagementStorage.addCustomerContact(validatedData);

  await auditService.customerUpdated(user.id, id, {
    changedFields: ["notfallkontakt_hinzugefügt"],
    oldValues: {},
    newValues: { vorname: contact.vorname, nachname: contact.nachname, contactType: contact.contactType },
  }, req.ip);

  res.status(201).json(contact);
}));

router.patch("/:id/contacts/:contactId", asyncHandler("Kontakt konnte nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(customerId) || isNaN(contactId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const result = employeeContactUpdateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kontaktdaten", details: result.error.issues });
    return;
  }

  const contact = await customerManagementStorage.updateCustomerContact(contactId, result.data);
  if (!contact) { res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" }); return; }

  await auditService.customerUpdated(user.id, customerId, {
    changedFields: ["notfallkontakt_aktualisiert"],
    oldValues: {},
    newValues: { contactId, ...result.data },
  }, req.ip);

  res.json(contact);
}));

router.delete("/:id/contacts/:contactId", asyncHandler("Kontakt konnte nicht gelöscht werden", async (req, res) => {
  const user = req.user!;
  const customerId = parseInt(req.params.id);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(customerId) || isNaN(contactId)) { res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige ID" }); return; }

  if (!user.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedCustomerIds.includes(customerId)) { res.status(403).json({ error: "Zugriff verweigert" }); return; }
  }

  const deleted = await customerManagementStorage.deleteCustomerContact(contactId);
  if (!deleted) { res.status(404).json({ error: "NOT_FOUND", message: "Kontakt nicht gefunden" }); return; }

  await auditService.customerUpdated(user.id, customerId, {
    changedFields: ["notfallkontakt_gelöscht"],
    oldValues: { contactId },
    newValues: {},
  }, req.ip);

  res.json({ success: true });
}));

router.post("/", asyncHandler("Kunde konnte nicht erstellt werden", async (req, res) => {
  const validatedData = insertCustomerSchema.parse(req.body);

  const customer = await db.transaction(async (tx) => {
    const result = await tx.insert(customers).values(validatedData).returning();
    return result[0];
  });

  customerIdsCache.invalidateForCustomer(customer.primaryEmployeeId, customer.backupEmployeeId);
  birthdaysCache.invalidateAll();
  
  res.status(201).json(customer);
}));

const signaturePayloadSchema = z.object({
  signatures: z.array(z.object({
    templateSlug: z.string().min(1),
    customerSignatureData: z.string().regex(/^data:image\/(png|jpeg);base64,/, "Ungültiges Signaturformat"),
  })),
  signingLocation: z.string().nullable().optional(),
});

router.post("/:id/signatures", asyncHandler("Unterschriften konnten nicht gespeichert werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId)) {
    res.status(400).json({ error: "Ungültige Kunden-ID" });
    return;
  }

  const user = req.user!;
  if (!user.isAdmin) {
    const assignedIds = await storage.getAssignedCustomerIds(user.id);
    if (!assignedIds.includes(customerId)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Kein Zugriff auf diesen Kunden",
      });
      return;
    }
  }

  const customer = await storage.getCustomer(customerId);
  if (!customer) {
    res.status(404).json({ error: "Kunde nicht gefunden" });
    return;
  }

  const parsed = signaturePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ungültige Daten", details: parsed.error.issues });
    return;
  }

  const userId = user.id;
  const signingIp = req.ip || req.socket.remoteAddress || null;
  const signingLocation = parsed.data.signingLocation || null;
  const results = [];
  const errors: { slug: string; error: string }[] = [];

  for (const sig of parsed.data.signatures) {
    try {
      const rendered = await renderTemplateForCustomer(sig.templateSlug, customerId);
      const hash = computeDataHash(JSON.stringify({
        customerId,
        templateId: rendered.templateId,
        templateVersion: rendered.templateVersion,
        customerSignatureData: sig.customerSignatureData,
      }));

      const doc = await documentStorage.createGeneratedDocument({
        customerId,
        templateId: rendered.templateId,
        templateVersion: rendered.templateVersion,
        fileName: `${sig.templateSlug}_signed.html`,
        objectPath: `generated/${customerId}/${sig.templateSlug}_${Date.now()}.html`,
        customerSignatureData: sig.customerSignatureData,
        integrityHash: hash,
        signingStatus: "complete" as const,
        signingIp,
        signingLocation,
      }, userId);
      results.push(doc);
    } catch (err) {
      errors.push({ slug: sig.templateSlug, error: String(err) });
      console.error(`Signatur ${sig.templateSlug} fehlgeschlagen:`, err);
    }
  }

  if (errors.length > 0 && results.length === 0) {
    res.status(500).json({ error: "Alle Unterschriften fehlgeschlagen", details: errors });
    return;
  }

  res.status(results.length === parsed.data.signatures.length ? 201 : 207).json({ results, errors });
}));

const convertCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]),
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  geburtsdatum: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  telefon: z.string().optional().nullable(),
  festnetz: z.string().optional().nullable(),
  strasse: z.string().min(1),
  nr: z.string().min(1),
  plz: z.string().regex(/^\d{5}$/),
  stadt: z.string().min(1),
  pflegegrad: z.number().min(1).max(5).optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000).optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: z.string(),
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    telefon: z.string(),
    email: z.string().optional(),
  })).optional(),
  budgets: z.object({
    entlastungsbetrag45b: z.number(),
    verhinderungspflege39: z.number(),
    pflegesachleistungen36: z.number(),
    validFrom: z.string(),
  }).optional(),
  contract: z.object({
    contractStart: z.string(),
    contractDate: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    hoursPerPeriod: z.number(),
    periodType: z.string(),
    rates: z.array(z.object({
      serviceCategory: z.string(),
      hourlyRateCents: z.number(),
    })).optional(),
  }).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
});

router.post("/:id/convert", requireRoles("erstberatung"), asyncHandler("Konvertierung fehlgeschlagen", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  if (!req.user!.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(req.user!.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Zugriff verweigert" });
      return;
    }
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "erstberatung") {
    res.status(400).json({ error: "INVALID_STATUS", message: "Nur Erstberatungskunden können konvertiert werden" });
    return;
  }

  const data = convertCustomerSchema.parse(req.body);
  const userId = req.user!.id;
  const today = todayISO();
  const warnings: string[] = [];

  const updateData: any = {
    name: `${data.nachname}, ${data.vorname}`,
    vorname: data.vorname,
    nachname: data.nachname,
    email: data.email || null,
    telefon: data.telefon || null,
    festnetz: data.festnetz || null,
    address: `${data.strasse} ${data.nr}, ${data.plz} ${data.stadt}`,
    strasse: data.strasse,
    nr: data.nr,
    plz: data.plz,
    stadt: data.stadt,
    pflegegrad: data.pflegegrad || null,
    geburtsdatum: data.geburtsdatum || null,
    vorerkrankungen: data.vorerkrankungen || null,
    haustierVorhanden: data.haustierVorhanden || false,
    haustierDetails: data.haustierVorhanden ? (data.haustierDetails || null) : null,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    acceptsPrivatePayment: data.acceptsPrivatePayment ?? false,
    documentDeliveryMethod: data.documentDeliveryMethod || "email",
    billingType: data.billingType,
    status: "aktiv",
  };

  const updated = await customerManagementStorage.updateCustomer(id, updateData);
  if (!updated) {
    res.status(500).json({ error: "UPDATE_FAILED", message: "Kunde konnte nicht aktualisiert werden" });
    return;
  }

  if (data.pflegegrad && data.pflegegradSeit) {
    try {
      await customerManagementStorage.addCareLevelHistory({
        customerId: id,
        pflegegrad: data.pflegegrad,
        validFrom: data.pflegegradSeit,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Pflegegrad-Historie fehlgeschlagen:`, err);
      warnings.push("Pflegegrad-Historie konnte nicht gespeichert werden");
    }
  }

  if (data.insurance && isPflegekasseCustomer(data.billingType)) {
    try {
      await customerManagementStorage.addCustomerInsurance({
        customerId: id,
        insuranceProviderId: data.insurance.providerId,
        versichertennummer: data.insurance.versichertennummer,
        validFrom: data.insurance.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Versicherung fehlgeschlagen:`, err);
      warnings.push("Versicherung konnte nicht gespeichert werden");
    }
  }

  if (data.contacts) {
    for (let i = 0; i < data.contacts.length; i++) {
      const c = data.contacts[i];
      try {
        await customerManagementStorage.addCustomerContact({
          customerId: id,
          contactType: c.contactType as "familie" | "angehoerige" | "nachbar" | "hausarzt" | "betreuer" | "sonstige",
          isPrimary: c.isPrimary,
          vorname: c.vorname,
          nachname: c.nachname,
          telefon: c.telefon,
          email: c.email || null,
          sortOrder: i,
        });
      } catch (err) {
        console.error(`[POST /:id/convert] Kontakt ${i} fehlgeschlagen:`, err);
        warnings.push(`Kontakt "${c.vorname} ${c.nachname}" konnte nicht gespeichert werden`);
      }
    }
  }

  if (data.budgets && isPflegekasseCustomer(data.billingType)) {
    try {
      await customerManagementStorage.addCustomerBudget({
        customerId: id,
        entlastungsbetrag45b: data.budgets.entlastungsbetrag45b,
        verhinderungspflege39: data.budgets.verhinderungspflege39,
        pflegesachleistungen36: data.budgets.pflegesachleistungen36,
        validFrom: data.budgets.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Budgets fehlgeschlagen:`, err);
      warnings.push("Budgets konnten nicht gespeichert werden");
    }
  }

  if (data.contract) {
    try {
      const hauswirtschaftRate = data.contract.rates?.find(r => r.serviceCategory === "hauswirtschaft");
      const alltagsbegleitungRate = data.contract.rates?.find(r => r.serviceCategory === "alltagsbegleitung");
      const kilometerRate = data.contract.rates?.find(r => r.serviceCategory === "kilometer");
      await customerManagementStorage.createCustomerContract({
        customerId: id,
        contractStart: data.contract.contractStart,
        contractDate: data.contract.contractDate || null,
        vereinbarteLeistungen: data.contract.vereinbarteLeistungen || null,
        hoursPerPeriod: data.contract.hoursPerPeriod,
        periodType: data.contract.periodType as "week" | "month" | "year",
        hauswirtschaftRateCents: hauswirtschaftRate?.hourlyRateCents || 0,
        alltagsbegleitungRateCents: alltagsbegleitungRate?.hourlyRateCents || 0,
        kilometerRateCents: kilometerRate?.hourlyRateCents || 0,
        status: "active",
      }, userId);
    } catch (err) {
      console.error(`[POST /:id/convert] Vertrag fehlgeschlagen:`, err);
      warnings.push("Vertrag konnte nicht erstellt werden");
    }
  }

  if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined) {
    try {
      await customerManagementStorage.updateCustomer(id, {
        primaryEmployeeId: data.primaryEmployeeId ?? null,
        backupEmployeeId: data.backupEmployeeId ?? null,
      });
    } catch (err) {
      console.error(`[POST /:id/convert] Mitarbeiter-Zuordnung fehlgeschlagen:`, err);
      warnings.push("Mitarbeiter-Zuordnung konnte nicht gespeichert werden");
    }
  }

  birthdaysCache.invalidateAll();

  res.json({ ...updated, status: "aktiv", warnings: warnings.length > 0 ? warnings : undefined });
}));

router.post("/:id/reject", requireRoles("erstberatung"), asyncHandler("Ablehnung fehlgeschlagen", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  if (!req.user!.isAdmin) {
    const assignedCustomerIds = await storage.getAssignedCustomerIds(req.user!.id);
    if (!assignedCustomerIds.includes(id)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Zugriff verweigert" });
      return;
    }
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (customer.status !== "erstberatung") {
    res.status(400).json({ error: "INVALID_STATUS", message: "Nur Erstberatungskunden können abgelehnt werden" });
    return;
  }

  const updated = await customerManagementStorage.updateCustomer(id, { status: "inaktiv" });
  res.json(updated);
}));

router.get("/:id/service-prices", requireAdmin, asyncHandler("Kundenpreise konnten nicht geladen werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const result = await db.execute(sql`
    SELECT csp.id, csp.customer_id AS "customerId", csp.service_id AS "serviceId",
           csp.price_cents AS "priceCents", csp.valid_from AS "validFrom", csp.valid_to AS "validTo",
           s.name AS "serviceName", s.code AS "serviceCode", s.default_price_cents AS "defaultPriceCents",
           s.unit_type AS "unitType"
    FROM customer_service_prices csp
    JOIN services s ON s.id = csp.service_id
    WHERE csp.customer_id = ${customerId} AND csp.valid_to IS NULL
    ORDER BY s.sort_order
  `);
  res.json(result.rows);
}));

router.post("/:id/service-prices", requireAdmin, asyncHandler("Kundenpreis konnte nicht gespeichert werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const parsed = insertCustomerServicePriceSchema.safeParse({ ...req.body, customerId });
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: parsed.error.message });
    return;
  }
  const { serviceId, priceCents } = parsed.data;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE customer_service_prices
      SET valid_to = NOW()
      WHERE customer_id = ${customerId} AND service_id = ${serviceId} AND valid_to IS NULL
    `);
    const inserted = await tx.execute(sql`
      INSERT INTO customer_service_prices (customer_id, service_id, price_cents)
      VALUES (${customerId}, ${serviceId}, ${priceCents})
      RETURNING id, customer_id AS "customerId", service_id AS "serviceId", price_cents AS "priceCents",
                valid_from AS "validFrom", valid_to AS "validTo"
    `);
    return inserted;
  });
  res.json(result.rows[0]);
}));

router.delete("/:id/service-prices/:priceId", requireAdmin, asyncHandler("Kundenpreis konnte nicht gelöscht werden", async (req, res) => {
  const customerId = parseInt(req.params.id);
  const priceId = parseInt(req.params.priceId);
  await db.execute(sql`
    UPDATE customer_service_prices
    SET valid_to = NOW()
    WHERE id = ${priceId} AND customer_id = ${customerId} AND valid_to IS NULL
  `);
  res.json({ success: true });
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

  const doc = await documentStorage.uploadCustomerDocument(result.data, user.id);
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
