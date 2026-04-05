import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCustomerSchema, versichertennummerSchema } from "@shared/schema";
import { optionalGermanPhoneSchema, internationalEmailSchema } from "@shared/schema/common";
import { requireAuth, requireRoles } from "../middleware/auth";
import { birthdaysCache, customerIdsCache } from "../services/cache";
import { documentStorage } from "../storage/documents";
import { isPflegekasseCustomer } from "@shared/domain/customers";
import { generateAndStorePdf } from "../services/document-pdf";
import { computeDataHash } from "../services/signature-integrity";
import { customerManagementStorage } from "../storage/customer-management";
import { asyncHandler } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { authService } from "../services/auth";
import { todayISO, validateGeburtsdatum } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { customers, prospects, prospectNotes } from "@shared/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { auditService } from "../services/audit";
import contactsRouter from "./customers/contacts";
import servicePricesRouter from "./customers/service-prices";
import documentsRouter from "./customers/documents";


const router = Router();

router.use(requireAuth);

router.use("/", documentsRouter);
router.use("/", contactsRouter);
router.use("/", servicePricesRouter);

router.get("/", asyncHandler("Kunden konnten nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const statusFilter = req.query.status as string | undefined;
  const viewAsEmployeeId = req.query.viewAsEmployeeId ? parseInt(req.query.viewAsEmployeeId as string) : undefined;
  
  if (user.isAdmin && !viewAsEmployeeId) {
    const searchFilter = req.query.search as string | undefined;
    const allCustomers = await storage.getCustomers({ status: statusFilter, search: searchFilter });
    res.json(allCustomers);
    return;
  }
  
  const employeeId = (user.isAdmin && viewAsEmployeeId) ? viewAsEmployeeId : user.id;
  let customersWithAccess = await storage.getCustomersForEmployee(employeeId);
  if (statusFilter) {
    customersWithAccess = customersWithAccess.filter(c => c.status === statusFilter);
  }
  res.json(customersWithAccess);
}));

router.get("/:id", asyncHandler("Kunde konnte nicht geladen werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  
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
  telefon: optionalGermanPhoneSchema.optional(),
  festnetz: optionalGermanPhoneSchema.optional(),
  email: z.string().transform(v => v?.trim() || "").pipe(internationalEmailSchema.or(z.literal(""))).nullable().optional().transform(v => !v || v === "" ? null : v),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500).nullable().optional(),
  vorerkrankungen: z.string().max(2000).nullable().optional(),
});

router.patch("/:id", asyncHandler("Kundendaten konnten nicht aktualisiert werden", async (req, res) => {
  const user = req.user!;
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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

router.post("/", asyncHandler("Kunde konnte nicht erstellt werden", async (req, res) => {
  const validatedData = insertCustomerSchema.parse(req.body);

  const geburtsdatumError = validateGeburtsdatum(validatedData.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
    return;
  }

  const customer = await db.transaction(async (tx) => {
    const result = await tx.insert(customers).values(validatedData).returning();
    return result[0];
  });

  customerIdsCache.invalidateForCustomer(customer.primaryEmployeeId, customer.backupEmployeeId, customer.backupEmployeeId2);
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
  const customerId = requireIntParam(req.params.id, res);
  if (customerId === null) return;

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
      const template = await documentStorage.getDocumentTemplateBySlug(sig.templateSlug);
      if (!template) {
        errors.push({ slug: sig.templateSlug, error: `Vorlage "${sig.templateSlug}" nicht gefunden` });
        continue;
      }

      const result = await generateAndStorePdf({
        template,
        customerId,
        customerSignatureData: sig.customerSignatureData,
        generatedByUserId: userId,
        signingStatus: "complete",
        signingIp,
        signingLocation,
      });

      const doc = await documentStorage.getGeneratedDocument(result.generatedDocId);
      if (doc) results.push(doc);
    } catch (err) {
      errors.push({ slug: sig.templateSlug, error: String(err) });
      console.error(`Signatur ${sig.templateSlug} fehlgeschlagen:`, err);
    }
  }

  if (errors.length > 0 && results.length === 0) {
    res.status(422).json({ code: "SIGNING_FAILED", message: "Alle Unterschriften fehlgeschlagen — bitte versuchen Sie es erneut", details: errors });
    return;
  }

  res.status(results.length === parsed.data.signatures.length ? 201 : 207).json({ results, errors });
}));

const convertCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]),
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  geburtsdatum: z.string().optional().nullable(),
  email: internationalEmailSchema.optional().nullable(),
  telefon: optionalGermanPhoneSchema,
  festnetz: optionalGermanPhoneSchema,
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
    versichertennummer: versichertennummerSchema,
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    festnetz: optionalGermanPhoneSchema,
    mobilnummer: optionalGermanPhoneSchema,
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
  backupEmployeeId2: z.number().nullable().optional(),
});

router.get("/:id/timeline", asyncHandler("Timeline konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

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

  type TimelineEntry = {
    phase: "akquise" | "kunde";
    type: string;
    text: string;
    createdAt: Date;
    userId?: number | null;
  };

  const timeline: TimelineEntry[] = [];

  if (customer.convertedFromProspectId) {
    const pNotes = await db
      .select()
      .from(prospectNotes)
      .where(eq(prospectNotes.prospectId, customer.convertedFromProspectId))
      .orderBy(desc(prospectNotes.createdAt));

    for (const note of pNotes) {
      timeline.push({
        phase: "akquise",
        type: note.noteType,
        text: note.noteText,
        createdAt: note.createdAt,
        userId: note.userId,
      });
    }

    timeline.push({
      phase: "kunde",
      type: "conversion",
      text: "Vertragsabschluss",
      createdAt: customer.createdAt,
      userId: customer.createdByUserId,
    });
  }

  timeline.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  res.json({
    prospectId: customer.convertedFromProspectId,
    entries: timeline,
  });
}));

export default router;
